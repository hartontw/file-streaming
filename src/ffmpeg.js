const fs = require('fs');
const path = require('path');
const {exec, spawn} = require('child_process');
const ffmpeg = `${process.env.FFMPEG_PATH}/ffmpeg`;
const ffprobe = `${process.env.FFMPEG_PATH}/ffprobe`;

/**
 * Execute a command as child process
 * @param {String} command Command to execute
 * @returns {Promise<String>} Promise resolving the command execution
 */
function execCommand(command)
{
    return new Promise( (resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error)
                reject(stderr);                
            else 
                resolve(stdout);
        });
    });
}

/**
 * Get all ffmpeg supported formats
 * @returns {Promise<JSON>} Promise resolving all suported formats in JSON
 */
function getFormats() {
    return new Promise( (resolve, reject) => {
        execCommand(`${ffmpeg} -formats`)
        .then(stdout => {
            const res = [];
            const rows = stdout.split('\n');
            for(let i = 4; i < rows.length-1; i++) {
                const row = rows[i].match(/[ \t]+(\S)+[ \t]+([^ \t]+)[ \t]+([^\r\n]+)/);
                res.push({
                    name: row[3],
                    extension: row[2],
                    muxing: row[1].includes('M'),
                    demuxing: row[1].includes('D')
                });
            }
            resolve(res);
        })
        .catch(reject);
    });
}

/**
 * Get raw info in JSON from ffprobe
 * @param {String} input Path or url to the file
 * @returns {Promise<JSON>} Promise resolving the info of the input in JSON
 */
function getRawInfo(input) {
    return new Promise( (resolve, reject) => {
        execCommand(`${ffprobe} -v quiet -print_format json -show_format -show_streams "${input}"`)
        .then(stdout => {
            resolve(JSON.parse(stdout));
        })
        .catch(reject);
    });
}

/**
 * Get info in JSON from ffprobe separte in meta/video/audio/subs
 * @param {String} input Path or url to the file
 * @returns {Promise<JSON>} Promise resolving the info of the input in JSON
 */
function getInfo(input) {
    return new Promise( (resolve, reject) => {
        getRawInfo(input)
        .then(info => {
            const duration = Math.floor(info.format.duration * 1000);
            const size = info.format.size;
            const creation_time = info.format.creation_time;
            const video = [], audio = [], subtitle = [];
            for(let i=0; i<info.streams.length; i++) {
                const stream = {
                    title: info.streams[i].tags && info.streams[i].tags.title,
                    language: info.streams[i].tags && info.streams[i].tags.language,
                    codec_name: info.streams[i].codec_name,
                    codec_long_name: info.streams[i].codec_long_name
                }
                switch(info.streams[i].codec_type){
                    case 'video':
                        stream.profile = info.streams[i].profile;
                        stream.width = info.streams[i].width;
                        stream.height = info.streams[i].height;
                        stream.sample_aspect_ratio = info.streams[i].sample_aspect_ratio;
                        stream.display_aspect_ratio = info.streams[i].display_aspect_ratio;
                        stream.pix_fmt = info.streams[i].pix_fmt;
                        stream.bit_rate = info.streams[i].bit_rate;
                        video.push(stream);
                        break;

                    case 'audio':
                        stream.channels = info.streams[i].channels;
                        stream.channel_layout = info.streams[i].channel_layout;
                        stream.bit_rate = info.streams[i].bit_rate;
                        audio.push(stream);
                        break;

                    case 'subtitle':
                        subtitle.push(stream);
                        break;
                }
            }
            resolve({
                link: input,
                duration,
                size,
                creation_time,
                video,
                audio,
                subtitle
            });
        })
        .catch(reject);
    });
}

/**
 * Get duration of a file
 * @param {String} input Path or url to the file
 * @returns {Promise<Number} Promise resolving the duration in miliseconds
 */
function getDuration(input) {
    return new Promise( (resolve, reject) => {
        execCommand(`${ffprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${input}`)
        .then(stdout => {
            resolve(Math.floor(stdout.replace('\r\n', '') * 1000));
        })
        .catch(reject);
    });
}

class Emission {
    constructor(link, destinationPath, startNumber, segmentTime, listSize, segmentFormat, listName) {
        this.link = link;
        this.startNumber = startNumber || 0;
        this.path = destinationPath;
        this.segment = {
            time: segmentTime || 10,
            format: path.join(destinationPath, `${segmentFormat}.ts`)
        };
        this.list = {
            size: listSize || 5,
            path: path.join(destinationPath, `${listName}.m3u8`)
        };
    }

    start(onData) {        
        return new Promise( (resolve, reject) => {
            if (this.running) {
                return reject('Already running');
            }

            this.running = true;

            //ffmpeg -re -i LINK -vf scale=w=1280:h=720:force_original_aspect_ratio=decrease -c:a aac -ar 48000 -b:a 128k -c:v h264 -profile:v main -crf 20 -g 48 -keyint_min 48 -sc_threshold 0 -b:v 2500k -maxrate 2675k -bufsize 3750k -start_number START_NUMBER -hls_time SEGMENT_TIME -hls_list_size LIST_SIZE -hls_segment_filename SEGMENT_FORMAT LIST_PATH
            this.process = spawn('ffmpeg', [
                '-re',
                '-i', `${this.link}`,
                '-vf', 'scale=w=1920:h=780:force_original_aspect_ratio=decrease',
                '-c:a', 'aac',
                '-ar', '48000',
                '-b:a', '128k',
                '-c:v', 'h264',
                '-profile:v', 'main',
                '-crf', '20',
                '-g', '48',
                '-keyint_min', '48',
                '-sc_threshold', '0',
                '-b:v', '2500k',
                '-maxrate', '2675k',
                '-bufsize', '3750k',
                '-start_number', `${this.startNumber}`,
                '-hls_time', `${this.segment.time}`,
                '-hls_list_size', `${this.list.size}`,
                '-hls_segment_filename', `${this.segment.format}`,
                `${this.list.path}`
            ]);            

            let index = this.startNumber;
    
            const knownErrors = [
                'No such file or directory',
                'Invalid data found when processing input',
                'No streams to mux were specified'
            ];
                
            const self = this;

            let writting = false;
    
            this.process.stderr.on('data', function(data) {        
                //console.log(data.toString());
                if (writting) {
                    writting = false;                        
                    self.index = index;
                    if (onData) {
                        onData(self);
                    }
                    index++;
                }
    
                const msg = data.toString();
    
                for(let err of knownErrors) {
                    if (msg.includes(err)) {
                        self.stop();
                        return reject(err, self);
                    }
                }
    
                writting = msg.match(/\.m3u8\.tmp' for writing/);
            });
            
            this.process.on('error', err => {
                self.running = false;
                return reject(err, self);
            });
            this.process.on('close', () => {
                self.running = false;
                return resolve(self);
            });
        })        
    }

    stop() {
        if (this.running) {
            this.running = false;
            this.process.stdin.pause();
            this.process.kill();
        }
    }
}

function getCommand(width, height, bitrate, maxrate, bufsize, audiorate) {
    return `-vf scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease -c:a aac -ar 48000 -b:a ${audiorate}k -c:v h264 -profile:v main -crf 20 -g 48 -keyint_min 48 -sc_threshold 0 -b:v ${bitrate}k -maxrate ${maxrate}k -bufsize ${bufsize}k -hls_time 6 -hls_list_size 5 -hls_wrap 40 -hls_start_number_source datetime -preset superfast -hls_segment_filename beach/${height}p_%03d.ts beach/${height}p.m3u8`;
}

function hls(input) {
    return new Promise( (resolve, reject) => {
        /*execCommand(`${ffmpeg} -re -y -i ${input}\
        ${getCommand(640, 360, 800, 856, 1200, 96)} \
        ${getCommand(842, 480, 1400, 1498, 2100, 128)} \
        ${getCommand(1280, 720, 2800, 2996, 4200, 128)} \
        ${getCommand(1920, 1080, 5000, 5350, 7500, 192)}`)
        .then(resolve)
        .catch(reject);*/
        execCommand(`${ffmpeg} -re -y -i ${input}\
        ${getCommand(1280, 720, 2800, 2996, 4200, 128)} \
        ${getCommand(1920, 1080, 5000, 5350, 7500, 192)}`)
        .then(resolve)
        .catch(reject);
    });    
}

module.exports = {
    getFormats,
    getRawInfo,
    getInfo,
    getDuration,
    Emission,
    hls
}

/*
ffmpeg -hide_banner -y -i beach.mkv \
  -vf scale=w=640:h=360:force_original_aspect_ratio=decrease -c:a aac -ar 48000 -c:v h264 -profile:v main -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod  -b:v 800k -maxrate 856k -bufsize 1200k -b:a 96k -hls_segment_filename beach/360p_%03d.ts beach/360p.m3u8 \
  -vf scale=w=842:h=480:force_original_aspect_ratio=decrease -c:a aac -ar 48000 -c:v h264 -profile:v main -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 1400k -maxrate 1498k -bufsize 2100k -b:a 128k -hls_segment_filename beach/480p_%03d.ts beach/480p.m3u8 \
  -vf scale=w=1280:h=720:force_original_aspect_ratio=decrease -c:a aac -ar 48000 -c:v h264 -profile:v main -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 2800k -maxrate 2996k -bufsize 4200k -b:a 128k -hls_segment_filename beach/720p_%03d.ts beach/720p.m3u8 \
  -vf scale=w=1920:h=1080:force_original_aspect_ratio=decrease -c:a aac -ar 48000 -c:v h264 -profile:v main -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 5000k -maxrate 5350k -bufsize 7500k -b:a 192k -hls_segment_filename beach/1080p_%03d.ts beach/1080p.m3u8
*/