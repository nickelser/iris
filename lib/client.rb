class Client
  @@id_counter = 0
  attr_reader :id
  
  def initialize(ws)
    @pub = EM::Hiredis.connect(CONFIG[:uri])
    @sub = EM::Hiredis.connect(CONFIG[:uri])
    
    @ws = ws
    @id = (@@id_counter += 1).to_s
    @channels = {}
    @aggregators = {}
    
    # instead of trying to reconnect to redis, which is fragile, just disconnect the user (who will attempt to reconnect)
    @pub.errback { @ws.close_connection }
    @sub.errback { @ws.close_connection }
    
    if ["endpoint", "redis"].include?(CONFIG[:auth_mechanism])
      # we need a side channel for authentication requests
      # as EM hiredis conns, once in pub/sub mode, get all mad at you if you abuse them
      @auth = EM::Hiredis.connect(CONFIG[:uri])
      @auth.errback { @ws.close_connection }
    end
    
    init_sub
  end
  
  def disconnect
    # seem to need to manually unsub. better safe than sorry!
    unsubscribe(@channels.keys.join(','))
    
    # and close out the redis connections
    @pub.close_connection
    @sub.close_connection
    
    @auth.close_connection if @auth
  end
  
  def publish(channel, msg)
    check_authentication(channel) do
      logger.debug "sending message: #{msg}"
      # wrap the message with our client id so we don't publish to ourselves
      @pub.publish(namespace + channel, {'msg' => msg, '__client_id' => @id}.to_json)
    end
  end
  
  # subscribe to one (or more) channels
  # multiple channels can be separated by commas
  def subscribe(channel_names, aggregator_name='')
    check_authentication(channel_names) do
      channel_names.split(',').each do |channel_name|
        unless channel_name.empty? || @channels.has_key?(channel_name)
          logger.debug "client #{@id} subscribed to: #{namespace+channel_name}"
          @sub.subscribe(namespace + channel_name)
          @channels[channel_name] = true
          @aggregators[channel_name] = Aggregator.new(aggregator_name) # will be pass-through if blank
        end
      end
    end
  end
  
  def unsubscribe(channel_names)
    # no need for auth checks here, channels only added if they are auth'd
    logger.debug "client(#{@id}) unsubscribed from: #{channel_names}"
    channel_names.split(',').each do |channel_name|
      if @channels.has_key?(channel_name)
        @sub.unsubscribe(namespace + channel_name)
        @channels.delete(channel_name)
        @aggregators.delete(channel_name)
      end
    end
  end
  
  def authenticate(user_id, token)
    @user_id = user_id
    @token = token
    @authenticated_channels = {}
    @global_authenticated = nil
    
    check_authentication
  end
  
  private
  
  def init_sub
    @sub.on(:message) do |channel, json_message|
      begin
        message = JSON.parse(json_message)
        real_message = {}
        
        # strip the namespace off
        channel.gsub! /^#{namespace}/, ""
        
        # unwrap the message to remove our client id, and discard the message if this client sent it
        if message.has_key?('__client_id')
          if message.has_key?('msg') && message['__client_id'] != @id
            real_message = message['msg']
          end
          # NB no else condition here; ignore the message entirely
        else
          real_message = message # if no __client_id, probably sent 'out of band', so foward it on with due dilligence
        end
        
        logger.debug "message (client: #{@id}) (chan: #{channel}): #{real_message.inspect}"
        
        unless real_message.empty?
          # and send it to the aggregator (will pass-through if necessary)
          @aggregators[channel].add(real_message) do |msg|
            logger.debug "sending to client(#{@id}) on channel(#{channel}): #{msg.inspect}"
            @ws.send({chan: channel, msg: msg}.to_json)
          end
        end
      rescue JSON::ParserError
        # consume these
      end
    end
  end
  
  # this hot mess uses the auth mechanism to see if the current user is authorized to
  # 1) perform global actions (subscribe/publish)
  # 2) pub/sub to specific channels
  def check_authentication(channel_names='', &block)
    case CONFIG[:auth_mechanism]
    when "redis"
      if @global_authenticated
        yield if block_given?
        return
      elsif @global_authenticated == false
        return # user is confirmed unauthed; they can request re-auth with another auth call
      else
        return if @user_id.nil? || @token.nil?
        @auth.get("#{namespace}#{CONFIG[:auth_redis_key]}:#{@user_id}") do |server_token|
          
          if server_token == @token
            set_global_authenticated
            logger.debug "authenticated #{@user_id}"
            yield if block_given?
          else
            @global_authenticated = false
            logger.warn "user #{@user_id} failed authentication with token #{@token}!"
          end
        end
      end
    when "endpoint"
      return if @user_id.nil? || @token.nil?
      global = channel_names.empty?
      channels = channel_names.split(',') rescue []
      
      # first handle the trivial cases: user is locally confirmed to be authenticated
      # or perhaps is confirmed to be unauthed (partially or completely)
      if (global && @global_authenticated) || (!global && all_channels_authed(channels))
        logger.debug "local auth succeeded for: #{@user_id} channels: #{channels.inspect}"
        yield if block_given?
        return
      elsif (global && @global_authenticated == false) || (!global && any_channels_unauthed(channels))
        logger.warn "local auth failed for: #{@user_id} channels: #{channels.inspect}"
        return # failed auth
      end
      
      # save our block info at this point as we are going deep into callback
      saved_block = block_given? ? block : nil
      
      # now we check redis for the key(s) and update local state information
      get_cached_tokens(channels, saved_block) do
        # cached authentication failed, so make a http request
        # to the endpoint to verify the permissions/user login
        query = {user_id: @user_id, token: @token}
        
        unless global
          query.merge!({channels: channel_names})
        end
        
        auth_request = EM::HttpRequest.new(CONFIG[:auth_endpoint]).post query: query
        
        auth_request.callback {
          if auth_request.response_header.status == 200
            if global
              set_global_authenticated
              cache_channel('', @token)
            else
              auth_all_channels(channels)
            end
            
            saved_block.call unless saved_block.nil?
          else
            if global
              @global_authenticated = false
            else
              unauth_unset_channels(channels)
            end
            
            logger.warn "user #{@user_id} failed authentication with token #{@token}!"
          end
        }
      end
    else
      set_global_authenticated
      yield if block_given?
    end
  end
    
  def all_channels_authed(channels)
    channels.each do |c|
      return false unless @authenticated_channels.has_key?(c)
    end
    
    return true
  end
  
  def any_channels_unauthed(channels)
    channels.each do |c|
      return true if @authenticated_channels[c] == false
    end
    
    return false
  end
  
  def auth_all_channels(channels)
    channels.each do |c|
      @authenticated_channels[c] = true
      cache_channel(c, @token)
    end
  end
  
  def unauth_unset_channels(channels)
    channels.each do |c|
      @authenticated_channels[c] = false unless @authenticated_channels.has_key?(c)
    end
  end
  
  # cache a users auth token for half an hour to avoid repeated api calls
  def cache_channel(c, val)
    @auth.set(key_for_token_cache(c), val) do
      @auth.expires(key_for_token_cache(c), 30*60) # expire in 30 minutes
    end
  end
  
  def key_for_token_cache(c)
    "#{namespace}#{CONFIG[:auth_user_token_cache]}:#{@user_id}:#{c}"
  end
  
  def set_global_authenticated
    if !@global_authenticated
      @global_authenticated = true
      @ws.send({auth: true}.to_json)
    end
  end
  
  def get_cached_tokens(channel_names, saved_block, &block)
    # map the empty set (global) to a blank string
    if channel_names.empty?
      channel_names = ['']
    end
    
    real_channel_names = Hash[channel_names.map { |c| [key_for_token_cache(c), c] }]
    
    @auth.mget(*real_channel_names.keys) do |channels|
      valid_channels = []
      # 3 cases
      # 1) key exists, and token == token. success!
      # 2) key exists, token != token. flush it and allow auth to proceed
      # 2) key does not exist. allow auth to proceed
      chan_names = real_channel_names.values # need to do this as the ordering might be different, and mget
                                             # does not return a mapping!
      chan_names.each_index do |i|
        chan = chan_names[i]
        
        if channels[i] != nil && channels[i] == @token
          valid_channels << chan
          if chan.empty?
            set_global_authenticated
          else
            @authenticated_channels[chan] = true
          end
        end
      end
      
      if (channel_names - valid_channels).empty?
        logger.debug "cached auth succeeded for: #{@user_id} cached: #{saved_block.nil?}"
        saved_block.call() unless saved_block.nil? # authentication succeeded!
      else
        logger.debug "cached auth failed for: #{@user_id}"
        yield # failed; yield to http auth
      end
    end
  end
end