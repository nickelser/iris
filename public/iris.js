// iris client code :)
(function () {
  if (window.Iris) {
    return;
  }
  
  window._iris_debug = false;
  
  // these are needed for web_socket
  window.WEB_SOCKET_SWF_LOCATION = "WebSocketMain.swf";
  window.WEB_SOCKET_DEBUG = window._iris_debug;
  
  window.Iris = function(url, user_id, user_token, protocols, proxyHost, proxyPort, headers) {
    var that = this;
    
    this._subscriptions = {};
    this._deferred_messages = [];
    
    this._user_id = user_id;
    this._user_token = user_token;
    
    this._url = url;
    this._protocols = protocols;
    this._proxyHost = proxyHost;
    this._proxyPort = proxyPort;
    this._headers = headers;
    
    this._retry_timeout = 1000; // start it at one second, then back off
    
    this._open_socket();
  };
  
  /*
  * pass a string to subscribe to one channel
  * or an array to subscribe to many
  * aggregator is an optional string parameter specifying which aggregtion recipe to use, if any
  * valid aggregators are 'additive', 'diff' and 'throttle'
  * if you have already specified an aggregator (or lack thereof), you cannot do so again
  */
  Iris.prototype.subscribe = function(callback, channels, aggregator) {
    if (is_array(channels)) {
      if (channels.length == 0) {
        return;
      }
      for (var i = 0; i < channels.length; i++) {
        this._add_callback_to_channel(callback, channels[i], aggregator);
      }
    } else {
      this._add_callback_to_channel(callback, channels, aggregator);
    }
    
    // if not authenticated, the onmessage after auth will take care of subscriptions
    if (this._authenticated) {
      this._subscribe();
    }
  };
  
  /*
  * unsubscribes from a single channel (if string arg), or list of channels (if array)
  * this will cancel *all* callbacks for that channel
  */
  Iris.prototype.unsubscribe = function(channels) {
    var unsub_list = [];
    
    if (is_array(channels)) {
      for (var i = 0; i < channels.length; i++) {
        this._unsubscribe(channels[i], unsub_list);
      }
    } else {
      this._unsubscribe(channels, unsub_list);
    }
    
    if (unsub_list.length > 0 && this._authenticated) {
      this._send({unsub: unsub_list.join(',')});
    }
    
    _debug("unsubscribe", "after unsub, state: ", this._subscriptions);
  };
  
  /*
  * publishes a message to a channel
  * if the connection is not yet open, the message will be published when it is
  * it is a good idea to subscribe to channels that you are publishing to in the case of authenticated
  * requests, as the auth request will be sent with the subscribe instead of at publish time
  * 
  * NB: messages are not sent back to the client that initially sent them
  */
  Iris.prototype.publish = function(channel, message) {
    if (channel.length > 0) {
      this._deferred_messages.push({chan: channel, pub: message});
    }
    
    if (this._authenticated) {
      this._publish();
    }
  };
  
  /* internal methods follow */
  
  Iris.prototype._publish = function() {
    while (this._deferred_messages.length > 0) {
      var msg = this._deferred_messages.pop();
      this._send(msg);
      _debug("_publish", "sent: ", msg);
    }
  };
  
  Iris.prototype._unsubscribe = function(channel, unsub_list) {
    if (channel in this._subscriptions) {
      if (this._subscriptions[channel].has_subscribed) {
        unsub_list.push(channel);
      }
      
      delete this._subscriptions[channel];
    }
  };
  
  Iris.prototype._add_callback_to_channel = function(callback, channel, aggregator) {
    if (channel in this._subscriptions) {
      this._subscriptions[channel].callbacks.push(callback);
    } else {
      var real_agg = "";
      
      if (aggregator !== undefined) {
        real_agg = aggregator;
      }
      
      this._subscriptions[channel] = {agg: real_agg, callbacks: [callback], has_subscribed: false};
    }
  };
  
  Iris.prototype._subscribe = function() {
    var to_subscribe = {};
    
    // collect channels by aggregation type
    for (channel in this._subscriptions) {
      if (this._subscriptions.hasOwnProperty(channel) && !this._subscriptions[channel].has_subscribed) {
        if (this._subscriptions[channel].agg in to_subscribe) {
          to_subscribe[this._subscriptions[channel].agg].push(channel);
        } else {
          to_subscribe[this._subscriptions[channel].agg] = [channel];
        }
        
        this._subscriptions[channel].has_subscribed = true;
      }
    }
    
    // and actually send the subscriptions
    // we collect by aggregation type so we can do batch subscriptions
    if (obj_size(to_subscribe) > 0) {
      for (agg in to_subscribe) {
        if (to_subscribe.hasOwnProperty(agg)) {
          var sub_str = to_subscribe[agg].join(',');
          this._send({sub: sub_str, agg: agg});
          _debug("_subscribe", "subscribed to: ", sub_str, " with aggregator: ", agg);
        }
      }
    }
    
    _debug("_subscribe", "subscription state now: ", this._subscriptions);
  };
  
  Iris.prototype._open_socket = function() {
    var that = this;
    
    this._authenticated = false;
    this._authenticating = false;
    this._connected = false;
    
    this.__ws = new WebSocket(this._url, this._protocols, this._proxyHost, this._proxyPort, this._headers);
    
    this.__ws.onopen = function(e) { that._handle_onopen(e); };
    this.__ws.onmessage = function(e) { that._handle_onmessage(e); };
    this.__ws.onclose = function(e) { that._handle_onclose(e); };
    
    _debug("_open_socket", "websocket + handlers initialized");
  };
  
  Iris.prototype._handle_onopen = function(e) {
    this._send({auth: this._user_id, token: this._user_token});
    this._authenticating = true;
    this._connected = true;
    this._retry_timeout = 1000; // reset the timeout
    
    _debug("_handle_onopen", "connection opened");
  };
  
  Iris.prototype._handle_onclose = function(e) {
    var that = this;
    
    // immediately set these
    this._connected = false;
    this._authenticated = false;
    this._authenticating = false;
    
    delete this.__ws;
    
    // ensure all of the subscription calls are cleared
    for (channel in this._subscriptions) {
      if (this._subscriptions.hasOwnProperty(channel)) {
        this._subscriptions[channel].has_subscribed = false;
      }
    }
    
    _debug("_handle_onclose", "connection closed, will attempt to reopen in "+this._retry_timeout/1000+"s");
    
    setTimeout(function() { that._open_socket(); }, this._retry_timeout); // attempt to reconnect
    
    // limit retry wait to 32s
    if (this._retry_timeout < 32000) {
      this._retry_timeout *= 2;
    }
  };
  
  Iris.prototype._handle_onmessage = function(e) {
    var data = JSON.parse(e.data);
    _debug("_handle_onmessage", "message: ", data);
    
    if (this._authenticating) {
      if (data.auth) {
        this._authenticating = false;
        this._authenticated = true;
        
        // now do our deferred subs and pubs
        // unsubs are handled more gracefully
        this._subscribe();
        this._publish();
      } else {
        this._authenticating = false;
        console.log("authentication failed!");
      }
    } else if (this._authenticated && data.hasOwnProperty('chan') && data.hasOwnProperty('msg') && this._subscriptions.hasOwnProperty(data.chan)) {
      for (var i = 0; i < this._subscriptions[data.chan].callbacks.length; i++) {
        this._subscriptions[data.chan].callbacks[i](data.msg, data.chan);
      }
    }
  };
  
  Iris.prototype._send = function(data) {
    this.__ws.send(JSON.stringify(data));
  };
  
  
  /* utility fns */
  function obj_size(obj) {
    var size = 0, key;
    
    for (key in obj) {
      if (obj.hasOwnProperty(key)) size++;
    }
    
    return size;
  }
  
  var is_array = Array.isArray || function(obj) {
     return toString.call(obj) === '[object Array]';
   };
   
   function _debug() {
     if (window._iris_debug && window.console && (typeof console.log === "function")) {
       // make arguments bend to my will
       console.log.apply(console, ["iris_debug(" + Array.prototype.slice.call(arguments)[0] + "): "].concat(Array.prototype.slice.call(arguments, 1)));
      }
   }
})();