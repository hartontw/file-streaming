# A basic module to stream files in hls 

**Requires ffmpeg**
```js
process.env.FFMPEG || 'ffmpeg';
```

**Examples**
```js
const fileStreaming = require('file-streaming');

const emission = new fileStreaming('/home/user/streaming');

// Looping video
function emit(input) {
    emission.emit(input)
    .then( e => {
        emit(e.input);
    })
    .catch(console.error);
}

emit('/home/user/videos/Test1.mp4');
```

```js
const fileStreaming = require('file-streaming');

// dir, url, resolutionMask = 4, segmentTime = 5, listSize = 5
const emission = new fileStreaming('/home/user/streaming', 'http://192.168.1.120:3000', 6, 10, 4);

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

**Resolution Mask**
**1:** 360p
**2:** 480p
**4:** 720p
**8:** 1080p

Examples:
**3:** 480p and 360p
**6:** 720p and 480p