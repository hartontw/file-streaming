require('dotenv').config();
const ffmpeg = require('./src/ffmpeg');
const express = require('express');
/*
const app = express();

app.use(express.static('beach'));

const input = 'C:/Users/Harton/Videos/Agujeros.mp4';
const path = 'C:/Users/Harton/Videos/Test/'

const emmision = new ffmpeg.Emission(input, path, 0, 2, 5, 'Video%05d', 'Video');

ffmpeg.hls(input)
.then(console.log)
.catch(console.error);

app.listen(3000, '192.168.1.48');
*/

const live = require('./src/index');

const emission = new live('test', 3);

const input = 'C:/Users/Harton/Videos/Agujeros.mp4';

function emit(i) {
    emission.emit(i)
    .then(() => {
        console.log(i);
    })
    .catch(console.error);
}

setTimeout(()=> {
    console.log("YE");
   // emit('C:/Users/Harton/Videos/Godot.mp4');
}, 10000);

emit(input);
