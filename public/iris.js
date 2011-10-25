// iris client code :)
(function () {
  if (window.Iris) {
    return;
  }
  
  window._iris_debug = false;
  
  // these are needed for web_socket
  window.WEB_SOCKET_SWF_LOCATION = "WebSocketMain.swf";
  window.WEB_SOCKET_DEBUG = window._iris_debug;
  
  window.Iris = function(url, endpoint, protocols, proxyHost, proxyPort, headers) {
    var that = this;
    
    this._subscriptions = {};
    this._auth_tokens = {};
    this._deferred_messages = [];
    
    this._url = url;
    this._protocols = protocols;
    this._proxyHost = proxyHost;
    this._proxyPort = proxyPort;
    this._headers = headers;
    this._endpoint = endpoint;
    
    this._retry_timeout = 1000; // start it at one second, then back off
    
    _debug("iris", "iris initialized; url: ", url, " endpoint: ", endpoint);
    
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
    if (is_array(channels)) {
      if (channels.length == 0) {
        return;
      }
      for (var i = 0; i < channels.length; i++) {
        this._subscribe(callback, channels[i], aggregator);
      }
    } else {
      this._subscribe(callback, channels, aggregator);
    }
  };
  
  /*
  * unsubscribes from a single channel (if string arg), or list of channels (if array)
  * this will cancel *all* callbacks for that channel
  */
  Iris.prototype.unsubscribe = function(channels) {
    if (is_array(channels)) {
      for (var i = 0; i < channels.length; i++) {
        this._unsubscribe(channels[i]);
      }
    } else {
      this._unsubscribe(channels);
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
    
    var that = this;
    
    this._authorize(channel, function() {
      that._publish();
    });
  };
  
  /* internal methods follow */
  
  Iris.prototype._publish = function() {
    while (this._deferred_messages.length > 0) {
      var msg = this._deferred_messages.pop();
      this._send(msg.chan, msg);
      _debug("_publish", "sent: ", msg);
    }
  };
  
  Iris.prototype._unsubscribe = function(channel) {
    if (channel in this._subscriptions) {
      var that = this;
      this._authorize(channel, function() {
        that._send(channel, {unsub: channel});
        delete that._subscriptions[channel];
      });
    }
  };
  
  Iris.prototype._subscribe = function(callback, channel, aggregator) {
    if (channel in this._subscriptions) {
      this._subscriptions[channel].callbacks.push(callback);
    } else {
      var real_agg = "", that = this;
      
      if (aggregator !== undefined) {
        real_agg = aggregator;
      }
      
      this._subscriptions[channel] = {callbacks: [], agg: real_agg};
      
      this._authorize(channel, function() {
        that._subscriptions[channel].callbacks.push(callback);
        that._send(channel, {sub: channel, agg: real_agg});
        _debug("_subscribe", "subscribed to: ", channel, " with aggregator: ", real_agg);
      });
    }
  };
  
  Iris.prototype._resubscribe = function() {
    for (channel in this._subscriptions) {
      if (this.hasOwnProperty(channel)) {
        var that = this;
        this._authorize(channel, function() {
          that._send(channel, {sub: channel, agg: that._subscriptions[channel].agg});
        });
      }
    }
  };
  
  Iris.prototype._open_socket = function() {
    var that = this;
    
    this._connected = false;
    this._id = null;
    this._auth_tokens = {};
    this._authorizing = {};
    
    this.__ws = new WebSocket(this._url, this._protocols, this._proxyHost, this._proxyPort, this._headers);
    
    this.__ws.onopen = function(e) { that._handle_onopen(e); };
    this.__ws.onmessage = function(e) { that._handle_onmessage(e); };
    this.__ws.onclose = function(e) { that._handle_onclose(e); };
    
    _debug("_open_socket", "websocket + handlers initialized");
  };
  
  Iris.prototype._handle_onopen = function(e) {
    this._retry_timeout = 1000; // reset the timeout
    _debug("_handle_onopen", "connection opened");
  };
  
  Iris.prototype._handle_onclose = function(e) {
    var that = this;
    
    // immediately set this
    this._connected = false;
    
    // and clear our tokens (they won't be valid any more)
    this._auth_tokens = {};
    // and any pending authorizors
    this._authorizing = {};
    
    delete this.__ws;
    
    _debug("_handle_onclose", "connection closed, will attempt to reopen in "+this._retry_timeout/1000+"s");
    
    setTimeout(function() { that._open_socket(); }, this._retry_timeout); // attempt to reconnect
    
    // limit retry wait to 32s
    if (this._retry_timeout < 32000) {
      this._retry_timeout *= 2;
    } else {
      // crush any pending messages, they aren't going to be delivered any time soon
      this._deferred_messages.length = 0;
    }
  };
  
  Iris.prototype._handle_onmessage = function(e) {
    var data = JSON.parse(e.data);
    _debug("_handle_onmessage", "message: ", data);
    
    if (!this._connected) {
      if (!data.id) {
        _debug("_handle_onmessage", "expected my id, instead got nothing");
        return;
      }
      
      this.__id = data.id;
      var that = this;
      
      _debug("_handle_onmessage", "received my id: ", data.id, " now attempting to authorize");
      
      this._authorize('', function() {
        that._connected = true;
        
        that._resubscribe(); // sub to existing channels
        that._publish(); // and automagically pub pending messages
      });
    } else if (data.hasOwnProperty('chan') && data.hasOwnProperty('msg') && this._subscriptions.hasOwnProperty(data.chan)) {
      for (var i = 0; i < this._subscriptions[data.chan].callbacks.length; i++) {
        this._subscriptions[data.chan].callbacks[i](data.msg, data.chan);
      }
    }
  };
  
  Iris.prototype._authorize = function(channel, callback) {
    if (this._auth_tokens[channel] === false) {
      // failed
      _debug("_authorize", "attempted call to authorize after already failed!");
      return;
    } else if (this._auth_tokens[channel]) {
      if (callback) { callback(); }
    } else if (this._authorizing[channel]) {
      if (callback) { this._authorizing[channel].push(callback); }
    } else {
      if (!this._endpoint && callback) {
        _debug("_authorize", "no endpoint specified, assuming no auth!");
        callback();
        return;
      }
      
      var that = this;
      var xhr = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject("Microsoft.XMLHTTP");
      
      xhr.open("POST", this._endpoint, true);
      xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
      
      this._authorizing[channel] = [callback];
      
      xhr.onreadystatechange = function() {
        if (xhr.readyState == 4){
          if (xhr.status == 200) {
            _debug("_authorize", "authorized!");
            var auth = JSON.parse(xhr.responseText);
            that._auth_tokens[channel] = auth.token;
            
            for (var i = 0; i < that._authorizing[channel].length; i++) {
              that._authorizing[channel][i]();
            }
            
            delete that._authorizing[channel];
          } else {
            _debug("_authorize", "authorize failed!");
            that._auth_tokens[channel] = false;
          }
        }
      };
      
      xhr.send('channel=' + channel +'&id=' + this.__id);
    }
  };
  
  Iris.prototype._send = function(channel, data) {
    if (this._endpoint) {
      data.a = this._auth_tokens[channel];
    }
    
    this.__send(data);
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