# aggregate frequent publishes into single messages to clients
class Aggregator
  def initialize(method)
    meth_sym = "recipe_#{method}".to_sym
    
    if !method.nil? && !method.empty? && self.respond_to?(meth_sym)
      @method = meth_sym
    end
    
    @working_msg = {}
  end
  
  # process a new message, expected to be in string json form
  def add(msg, &block)
     # pass-through if invalid recipe or type
     # unless it's a throttle, which can handle any type as it does not do any sort of deep inspection
    if @method.nil? || (!msg.kind_of?(Hash) && @method != :recipe_throttle)
      yield(msg)
    else
      self.send(@method, msg) # aggregate it using our fancy recipes
      
      now = Time.now.to_i
      
      if @last_call.nil?
        @last_call = now
      end
      
      # cancel any existing timer; either we will be calling immediately (case 1 below)
      # or another timer will be started
      EM::cancel_timer(@timer) unless @timer.nil?
      
      # two cases for sending the aggregated message
      # 1) time elapsed since last call is over the aggregation time, so force a call
      # 2) time has not elapsed, so collect more and pass a timer so we can be sure to get called
      if now - @last_call > CONFIG[:aggregation_time]
        @last_call = now
        yield(pop())
      else
        @timer = EM::add_timer CONFIG[:aggregation_time] do
          @last_call = now
          yield(pop())
        end
      end
    end
  end
  
  # return the aggregated message
  # this clears the working message
  def pop
    ret = @working_msg.dup
    @working_msg = {}
    ret
  end
  
  protected
  
  def recipe_additive(msg)
    msg.each_pair do |k, v|
      if @working_msg.has_key?(k)
        @working_msg[k] += v.to_i
      else
        @working_msg[k] = v.to_i
      end
    end
  end
  
  def recipe_diff(msg)
    @working_msg.merge! hash_diff(@working_msg, msg)
  end
  
  def recipe_throttle(msg)
    @working_msg = msg
  end
  
  private
  
  # a little bootleg, but seems to work fine
  # conflicts resolved last-to-goal
  def hash_diff(h1, h2)
    if h1.nil? || h1.empty?
      return h2
    elsif h2.nil? || h2.empty?
      return h1
    end
    
    h2.dup.delete_if do |k, v|
      if h1.has_key?(k)
        if v.kind_of?(Hash)
          hash_diff(v, h1[k]).empty?
        else
          v == h1[k]
        end
      else
        false
      end
    end
  end
end