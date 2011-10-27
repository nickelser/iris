// iris client code :)
(function () {
  // just like the ifdefs of yore
  if (window.Iris) { return; }
  
  window._iris_debug = true;
  
  // these are needed for web_socket
  // TODO verify flash version works
  window.WEB_SOCKET_SWF_LOCATION = "http://localhost:8081/WebSocketMain.swf";
  window.WEB_SOCKET_DEBUG = window._iris_debug;
  window.WEB_SOCKET_SUPPRESS_CROSS_DOMAIN_SWF_ERROR = true;
  
  // TODO: make iris take an object to configure
  window.Iris = function(url, endpoint) {
    var that = this;
    
    this._subscriptions = {};
    this._auth_tokens = {};
    this._deferred_messages = {};
    
    this._url = url;
    this._endpoint = endpoint;
    
    this._retry_timeout = 1000; // start it at one second, then back off
    
    _debug("iris", "iris initialized; url:", url, "endpoint:", endpoint);
    
    this._open_socket();
  };
  
  /*
  * pass a string to subscribe to one channel
  * or an array to subscribe to multiple
  * aggregator is an optional string parameter specifying which aggregtion recipe to use, if any
  * valid aggregators are 'additive', 'diff' and 'throttle'
  * if you have already specified an aggregator (or lack thereof), you cannot do so again
  */
  Iris.prototype.subscribe = function(callback, channels, aggregator) {
    var channel_list = to_array(channels), new_channels = [];
    for (var i = 0; i < channel_list.length; i++) {
      if (channel_list[i] in this._subscriptions) {
        this._subscriptions[channel_list[i]].callbacks.push(callback);
      } else {
        var real_agg = (aggregator !== undefined) ? aggregator : "";
        this._subscriptions[channel_list[i]] = {callbacks: [callback], agg: real_agg};
        new_channels.push(channel_list[i]);
      }
    }
    
    this._authorize(new_channels, 'sub', function(channel) {
      this.__sub(channel);
      _debug("subscribe", "subscribed to:", channel, "with aggregator:", aggregator);
    }, function(channel) {
      delete this._subscriptions[channel]; // delete this subscription on auth errors
    });
  };
  
  /*
  * unsubscribes from a single channel (if string arg), or list of channels (if array)
  * this will cancel *all* callbacks for that channel
  */
  Iris.prototype.unsubscribe = function(channels) {
    // need to special case the connected/not connected situations
    // since we do not queue up unsubs
    var channel_list = to_array(channels), real_channels = [];
    for (var i = 0; i < channel_list.length; i++) {
      if (channel_list[i] in this._subscriptions) {
        delete this._subscriptions[channel_list[i]];
        real_channels.push(channel_list[i]);
      }
    }
    
    this._authorize(real_channels, 'sub', function(channel) {
      this.__unsub(channel);
      _debug("unsubscribe", "unsubscribed from:", channel);
    });
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
      if (channel in this._deferred_messages) {
        this._deferred_messages[channel].push(message);
      } else {
        this._deferred_messages[channel] = [message];
      }
    }
    
    // the _publish call actually pushes out any pending messages
    // and takes care of the auth
    this._publish();
  };
  
  /* 
  *
  * internal methods follow
  *
  */
  
  Iris.prototype._open_socket = function() {
    var that = this, ws_transport = null;
    
    this._connected = false;
    this._id = null;
    this._auth_tokens = {};
    this._authorizing = {};
    
    // TODO: do not load the SWF version unless necessary!
    if (window.MozWebSocket) {
      ws_transport = window.MozWebSocket;
    } else if (window.WebSocket) {
      ws_transport = window.WebSocket;
    } else {
      _debug("_open_socket", "no websocket transport found! bailing.");
      return;
    }
        
    this.__ws = new ws_transport(this._url);
    
    this.__ws.onopen = function(e) { that._handle_onopen(e); };
    this.__ws.onmessage = function(e) { that._handle_onmessage(e); };
    this.__ws.onclose = function(e) { that._handle_onclose(e); };
    this.__ws.onerror = function(e) { that._handle_onerror(e); };
    
    _debug("_open_socket", "websocket + handlers initialized:", this.__ws);
  };
  
  Iris.prototype._handle_onopen = function(e) {
    this._retry_timeout = 1000; // reset the timeout
    _debug("_handle_onopen", "connection opened");
    // TODO add timeout to call a function to check whether we've connected or not
    // and close/restart the connection if necessary
  };
  
  Iris.prototype._handle_onclose = function(e) {
    var that = this;
    
    // immediately set this
    this._connected = false;
    // and delete the existing connection
    delete this.__ws;
    
    _debug("_handle_onclose", "connection closed, will attempt to reopen in "+this._retry_timeout/1000+"s");
    
    setTimeout(function() { that._open_socket(); }, this._retry_timeout); // attempt to reconnect
    
    // limit retry wait to 32s
    if (this._retry_timeout < 32000) {
      this._retry_timeout *= 2;
    } else {
      // crush any pending messages, they aren't going to be delivered any time soon
      // keep, however, any subscriptions
      this._deferred_messages = {};
    }
  };
  
  Iris.prototype._handle_onmessage = function(e) {
    var data = JSON.parse(e.data);
    _debug("_handle_onmessage", "message:", data);
    
    if (!this._connected) {
      if (!data.id) {
        _debug("_handle_onmessage", "expected my id, instead got nothing");
        return;
      }
      
      this.__id = data.id;
      this._connected = true;
      
      this._resubscribe(); // sub to existing channels
      this._publish(); // and automagically pub pending messages
      
      _debug("_handle_onmessage", "successfully connected with id:", data.id);
    } else if (data.hasOwnProperty('chan') && data.hasOwnProperty('msg') && this._subscriptions.hasOwnProperty(data.chan)) {
      for (var i = 0; i < this._subscriptions[data.chan].callbacks.length; i++) {
        this._subscriptions[data.chan].callbacks[i](data.msg, data.chan);
      }
    }
  };
  
  Iris.prototype._handle_onerror = function(e) {
    _debug("_handle_onerror", "internal websockets error! drat:", e);
  };
  
  Iris.prototype._publish = function() {
    this._authorize(keys(this._deferred_messages), 'pub', function(channel) {
      while (this._deferred_messages[channel].length > 0) {
        var msg = this._deferred_messages[channel].pop();
        this.__pub(channel, msg);
        _debug("_publish", "sent:", msg);
      }
    }, function(channel) {
      delete this._deferred_messages[channel]; // clear the bad channel on errors
    });
  };
  
  Iris.prototype._resubscribe = function() {
    this._authorize(keys(this._subscriptions), 'sub', function(channel) {
      this.__sub(channel);
      _debug("_resubscribe", "resubscribed to:", channel);
    });
  };
  
  Iris.prototype._authorize = function(channel_list, action, callback, errback) {
    if (!this._connected) {
      // we couldn't possibly auth; just return (on connect we will take care of deferred actions)
      return;
    }
    
    // for convenience for the calls below
    if (!callback) { callback = function() {}; }
    if (!errback) { errback = function() {}; }
    
    // channels_to_be_authorized is a poor man's set
    var channels = to_array(channel_list), channels_to_be_authorized_set = {}, channels_already_authorized_set = {}, i;
    
    if (is_string(this._endpoint) && this._endpoint.length > 1) {
      for (i = 0; i < channels.length; i++) {
        var channel = channels[i];
        
        if (this._auth_tokens[channel] && !this._auth_tokens[channel][action]) {
          // failed
          _debug("_authorize", "attempted use of unauthorized action:", action, "on channel", channel);
          errback.call(this, channels[i]);
        } else if (this._auth_tokens[channel] && this._auth_tokens[channel][action]) {
          // we've already authorized this channel for this action, so callback immediately
          channels_already_authorized_set[channel] = true;
        } else if (this._authorizing[channel]) {
          this._authorizing[channel].callback.push(callback);
          this._authorizing[channel].errback.push(errback);
        } else {
          // failed through; looks like we need to auth the channel!
          channels_to_be_authorized_set[channel] = true;
        }
      }
    } else {
      // assume no auth
      for (i = 0; i < channels.length; i++) {
        callback.call(this, channels[i]);
      }
      return;
    }
    
    var channels_to_be_authorized = keys(channels_to_be_authorized_set), channels_already_authorized = keys(channels_already_authorized_set);
    _debug("_authorize", "channels to be authorized:", channels_to_be_authorized, "already authorized:", channels_already_authorized);
    
    for (i = 0; i < channels_already_authorized.length; i++) {
      callback.call(this, channels_already_authorized[i]);
    }
    
    // looks like we have some channels that still need to be authenticated
    if (channels_to_be_authorized.length > 0) {
      var that = this,
          xhr = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject("Microsoft.XMLHTTP");
      
      for (i = 0; i < channels_to_be_authorized.length; i++) {
        this._authorizing[channels_to_be_authorized[i]] = {callback: [callback], errback: [errback]};
      }
      
      xhr.open("POST", this._endpoint, true);
      xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
      
      xhr.onreadystatechange = function() {
        if (xhr.readyState == 4) {
          if (xhr.status == 200) {
            var auth_list = JSON.parse(xhr.responseText);
            if (!is_object(auth_list)) {
              _debug("_authorize", "auth server did not return an object of channels/auth tokens; ignoring response!");
              return;
            }
            
            for (channel in auth_list) {
              if (auth_list.hasOwnProperty(channel) && that._authorizing[channel]) {
                var auth = auth_list[channel];
                
                if (!is_object(auth) || (!('pub' in auth) && !('sub' in auth))) {
                  that._auth_tokens[channel] = {pub: false, sub: false};
                  
                  for (i = 0; i < that._authorizing[channel].length; i++) {
                    that._authorizing[channel].errback[i].call(that, channel);
                  }
                  
                  _debug("_authorize", "auth token invalid/empty for channel", channel);
                } else {
                  that._auth_tokens[channel] = {pub: (auth.pub && is_string(auth.pub) && auth.pub.length > 16) ? auth.pub : false,
                                                sub: (auth.sub && is_string(auth.sub) && auth.sub.length > 16) ? auth.sub : false};
                  
                  if ((action == 'pub' && auth.pub) || (action == 'sub' && auth.sub)) {
                    for (i = 0; i < that._authorizing[channel].callback.length; i++) {
                      that._authorizing[channel].callback[i].call(that, channel);
                    }
                    _debug("_authorize", "authorized:", channel);
                  } else {
                    for (i = 0; i < that._authorizing[channel].errback.length; i++) {
                      that._authorizing[channel].errback[i].call(that, channel);
                    }
                    _debug("_authorize", "server authorized channel:", channel, ", but not for action:", action);
                  }
                }
                
                delete that._authorizing[channel];
              }
            }
          } else {
            _debug("_authorize", "server returned something other than 200 OK; assuming all channels unauthorized");
            
            for (i = 0; i < channels_to_be_authorized.length; i++) {
              that._auth_tokens[channels_to_be_authorized[i]] = {pub: false, sub: false};
              for (var j = 0; j < that._authorizing[channels_to_be_authorized[j]].errback.length; j++) {
                that._authorizing[channels_to_be_authorized[i]].errback[j].call(that, channels_to_be_authorized[i]);
              }
              delete that._authorizing[channels_to_be_authorized[i]];
            }
          }
        }
      };
      
      var auth_channel_list = JSON.stringify(channels_to_be_authorized);
      _debug("_authorize", "contacting server for auth on channels", auth_channel_list);
      xhr.send('channels=' + encodeURIComponent(auth_channel_list) +'&id=' + encodeURIComponent(this.__id));
    }
  };
  
  Iris.prototype.__pub = function(channel, msg) {
    this._send(channel, 'pub', {pub: msg, chan: channel});
  };
  
  Iris.prototype.__sub = function(channel) {
    this._send(channel, 'sub', {sub: channel, agg: this._subscriptions[channel].agg});
  };
  
  Iris.prototype.__unsub = function(channel) {
    this._send(channel, 'sub', {unsub: channel});
  };
  
  Iris.prototype._send = function(channel, action, data) {
    if (this._endpoint) {
      if (this._auth_tokens[channel] && this._auth_tokens[channel][action]) {
        data.a = this._auth_tokens[channel][action];
        this.__send(data);
      } else {
        _debug("_send", "requested send/action for unauthorized channel:", channel, " and action:", action);
      }
    } else {
      this.__send(data);
    }
  };
  
  Iris.prototype.__send = function(data) {
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
  
  var keys = Object.keys || function(obj) {
    var keys = [];
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) keys.push(key);
    }
    return keys;
  };
  
  var is_array = Array.isArray || function(obj) {
    return toString.call(obj) == '[object Array]';
  };
   
  function is_object(obj) {
    return obj === Object(obj);
  }
  
  function is_string(obj) {
    return toString.call(obj) == '[object String]';
  };
  
  function to_array(obj) {
    if (obj === undefined || obj === null) {
      return [];
    } else if (is_array(obj)) {
      return obj;
    } else if (is_object(obj)) {
      return keys(obj);
    } else {
      return [obj];
    }
  }
  
  function _debug() {
    if (window._iris_debug && window.console && (typeof console.log === "function")) {
      // make arguments bend to my will
      console.log.apply(console, ["iris_debug(" + Array.prototype.slice.call(arguments)[0] + "):"].concat(Array.prototype.slice.call(arguments, 1)));
    }
  }
})();