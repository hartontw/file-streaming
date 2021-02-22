# A basic module to stream files in hls 

```js
const fileStreaming = require('file-streaming');

const emission = new fileStreaming('/home/user/streaming');

function emit(input) {
    emission.emit(input)
    .then( e => {
        console.log(`Finish: ${e.input}`);
    })
    .catch(console.error);
}

emit('/home/user/videos/Test1.mp4');

setTimeout( () => {
    emit('/home/user/videos/Test2.mp4');
}, 60000);
```