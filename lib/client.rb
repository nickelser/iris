class Client
  @@id_counter = 0
  attr_reader :id
  
  def initialize(ws)
    @pub = EM::Hiredis.connect(CONFIG[:uri])
    @sub = EM::Hiredis.connect(CONFIG[:uri])
    
    @ws = ws
    @id = HMAC::SHA256.hexdigest(TOKEN, Time.now.to_i.to_s + (@@id_counter += 1).to_s)[0..16]
    @channels = {}
    @cached_tokens = {}
    
    # instead of trying to reconnect to redis, which is fragile, just disconnect the user (who will attempt to reconnect)
    @pub.errback { @ws.close_connection }
    @sub.errback { @ws.close_connection }
    
    # send out the client's id
    @ws.send({id: @id}.to_json)
    
    # and initialize the subscription handler!
    init_sub
  end
  
  def disconnect
    # seem to need to manually unsub. better safe than sorry!
    @channels.keys.each { |c| @sub.unsubscribe(namespace + c) }
    
    # and close out the redis connections
    @pub.close_connection
    @sub.close_connection
  end
  
  def publish(channel, msg, token)
    if authorized(channel, token, 'pub')
      logger.debug "sending message: #{msg}"
      # wrap the message with our client id so we don't publish to ourselves
      @pub.publish(namespace + channel, {'msg' => msg, '__client_id' => @id}.to_json)
    end
  end
  
  # subscribe to a channel
  def subscribe(channel, token, aggregator_name='')
    if authorized(channel, token, 'sub')
      logger.debug "client #{@id} subscribed to: #{channel}"
      unless channel.empty? || @channels.has_key?(channel)
        @sub.subscribe(namespace + channel)
        @channels[channel] = Aggregator.new(aggregator_name) # will be pass-through if blank
      end
    end
  end
  
  def unsubscribe(channel, token)
    if authorized(channel, token, 'sub')
      logger.debug "client(#{@id}) unsubscribed from: #{channel}"
      if @channels.has_key?(channel)
        @sub.unsubscribe(namespace + channel)
        @channels.delete(channel)
      end
    end
  end
  
  private
  
  def authorized(channel, token, type)
    CONFIG[:auth] ? (token_for_channel(channel, type) == token) : true
  end
  
  def token_for_channel(channel, type)
    @cached_tokens[channel] ||= HMAC::SHA256.hexdigest(TOKEN, "#{channel}:#{@id}:#{type}")
  end
  
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
          @channels[channel].add(real_message) do |msg|
            logger.debug "sending to client(#{@id}) on channel(#{channel}): #{msg.inspect}"
            @ws.send({chan: channel, msg: msg}.to_json)
          end
        end
      rescue JSON::ParserError
        # consume these
      end
    end
  end
end