#!/usr/bin/env ruby
# -*- encoding: UTF-8 -*-

root_dir = File.expand_path(File.dirname(__FILE__) + "/..")
$:.unshift File.join(root_dir, "lib")

require 'eventmachine'
require 'em-websocket'
require 'em-hiredis'
require 'em-http-request'

require 'daemon_spawn'
require 'yaml'
require 'json'
require 'time'
require 'stream_logger'
require 'hmac-sha2'

require 'aggregator'
require 'client'

RUN_ENV = ENV['IRIS_ENV'] || ENV['RAKE_ENV'] || ENV['RAILS_ENV'] || 'development'

defaults = {
  uri: "redis://127.0.0.1:6379/0",
  namespace: "development",
  host: "0.0.0.0",
  port: 8080,
  auth_mechanism: "",
  auth_endpoint: "",
  auth_redis_key: "",
  auth_user_token_cache: "__user_tokens",
  log_level: "info",
  websockets_debug: false,
  aggregation_time: 1.5 # in seconds
}

CONFIG = defaults.merge! Hash[*(YAML.load(IO.read("#{root_dir}/iris.yml"))[RUN_ENV]).map { |k,v| [ k.to_sym, v ] }.flatten]

# some sanity checking
if ![nil, "", "endpoint", "redis"].include?(CONFIG[:auth_mechanism])
  throw "Invalid authentication mechanism; must be one of '', 'endpoint' or 'redis'!"
elsif CONFIG[:auth_mechanism] == "endpoint" && CONFIG[:auth_endpoint].empty?
  throw "Authentication set to endpoint, but no endpoint specified!"
elsif CONFIG[:auth_mechanism] == "redis" && CONFIG[:auth_redis_key].empty?
  throw "Authentication set to redis, but no table key specified!"
end

def namespace
  if CONFIG[:namespace].empty?
    ""
  else
    "#{CONFIG[:namespace]}:"
  end
end

# initialize logging
StreamLogger.logify!
logger.format do |level, message|
 "%s %5s %s[%s]: %s" % [Time.now.iso8601, level.upcase, $0, Process.pid, message]
end
logger.level = CONFIG[:log_level].to_sym || :info

class IrisServer < DaemonSpawn::Base
  def start(args)
    EventMachine.run do
      clients = {}
      
      EventMachine::WebSocket.start(host: CONFIG[:host], port: CONFIG[:port], debug: CONFIG[:websockets_debug]) do |ws|
        ws.onopen do
          logger.debug "client connected"
          clients[ws] = Client.new(ws)
        end
        
        ws.onclose do
          clients[ws].disconnect
          clients.delete ws
        end
        
        #ws.onerror do |error|
          # TODO
        #  if clients.has_key?(ws)
        #    clients[ws].disconnect
        #    clients.delete ws
        #  end
          #if e.kind_of?(EM::WebSocket::WebSocketError)
          #  ...
          #end
        #end
        
        ws.onmessage do |msg|
          begin
            msg = JSON.parse(msg)
            
            if msg.has_key? 'sub'
              clients[ws].subscribe(msg['sub'], msg['a'], msg['agg'])
            elsif msg.has_key?('pub') && msg.has_key?('chan')
              clients[ws].publish(msg['chan'], msg['pub'], msg['a'])
            elsif msg.has_key? 'unsub'
              clients[ws].unsubscribe(msg['unsub'], msg['a'])
            end
          rescue JSON::ParserError
            # consume these
          end
        end
      end
      
      logger.debug "started server"
    end
  end
  
  def stop
    logger.debug "stopping the server"
    EventMachine.stop
  end
end
 
 
IrisServer.spawn!({
  :log_file => File.expand_path("log/iris.log", root_dir),
  :pid_file => "/tmp/iris.pid",
  :sync_log => true,
  :working_dir => root_dir,
  :timeout => 10,
  :signal => "QUIT",
  :application => 'iris',
  :processes => 1
}, ARGV.dup)