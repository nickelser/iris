# Iris

Iris is a redis/websockets-based pub/sub server. It is comprised of the server (iris.rb), and the client-side JS.

## How to use

1. Ensure that your `iris.yml` config is correct. A sample file has been provided for your convenience.
2. Set up the JS/websocket SWF hosting. See the sample nginx.conf that provides for the crossdomain XML/static assets.
3. Start iris:
  ```
  bundle exec ./bin/iris.rb start
  ```
4. Write some boss JS code:
  ```javascript
  iris = new Iris("ws://localhost:8080", "nick", "1234")
  iris.subscribe(function(data, channel) {
    alert('Just got some data!');
  }, ['channel1', 'channel2']);
  ```


TBD: non-shitty README