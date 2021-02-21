const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const RENDITIONS = Object.freeze([
    {width: 640, height: 360, audiorate: 96, bitrate: 800, maxrate: 856, bufsize: 1200},
    {width: 842, height: 480, audiorate: 128, bitrate: 1400, maxrate: 1498, bufsize: 2100},
    {width: 1280, height: 720, audiorate: 128, bitrate: 2800, maxrate: 2996, bufsize: 4200},
    {width: 1920, height: 1080, audiorate: 192, bitrate: 5000, maxrate: 5350, bufsize: 7500},
]);

function readList(destinationPath) {
    const data = fs.readFileSync(destinationPath, 'UTF-8');
    let segment = data.match(/#EXTINF:[^\n]+\n[^\n]+/mg).pop();
    return {
        duration: data.match(/EXT-X-TARGETDURATION:([^\n]+)\n/)[1],
        sequence: data.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)\n/)[1] * 1,
        segment: {
            duration: segment.match(/#EXTINF:([^,]+),\n/)[1],
            file: segment.match(/#EXTINF:[^\n]+\n([^\n]+)/)[1]
        }
    };
}

function writeMasterList(dir, {duration, sequence, segments}) {
    const m3u8 = [];
    m3u8.push('#EXTM3U');
    m3u8.push('#EXT-X-VERSION:3');
    m3u8.push('#EXT-X-ALLOW-CACHE:YES');
    m3u8.push(`#EXT-X-TARGETDURATION:${duration}`);
    m3u8.push(`#EXT-X-MEDIA-SEQUENCE:${sequence}`);
    for(let i=0; i<segments.length; i++) {
        const segment = segments[i];
        if (segment.discontinuity) {
            m3u8.push('#EXT-X-DISCONTINUITY');
        }
        m3u8.push(`#EXTINF:${segment.duration},`);
        m3u8.push(segment.file);
    }
    fs.writeFileSync(dir, m3u8.join('\n'));
}

class Emission {
    constructor(dir, input, segmentTime, resolutionMask) {
        this._dir = dir;
        this._input = input;
        this._segmentTime = segmentTime;        
        this._timestamp = Date.now().toString();
        this._params = ['-re', '-i', `${input}`].concat(this.getRenditions(resolutionMask));
        this._list = [];
        for (let i=0; i<RENDITIONS.length; i++) {
            if (Math.pow(2, i) & resolutionMask) {   
                const rendition = RENDITIONS[i];
                this._list[rendition.height] = [];
            }
        }
    }

    get dir() { return this._dir; }
    get input() { return this._input; }
    get segmentTime() { return this._segmentTime; }
    get timestamp() { return this._timestamp; }    

    getRendition({width, height, audiorate, bitrate, maxrate, bufsize}) {
        const segment = path.join(this.dir, `${height}p_%03d.ts`);
        const list = path.join(this.dir, `${this.timestamp}_${height}p.m3u8`);
        return [
            '-vf', `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease`,
            '-c:a', 'aac', 
            '-ar', '48000',
            '-b:a', `${audiorate}k`,
            '-c:v', 'h264',
            '-profile:v', 'main',
            '-crf', '20',
            '-g', '48',
            '-keyint_min', '48',
            '-sc_threshold', '0',
            '-b:v', `${bitrate}k`,
            '-maxrate', `${maxrate}k`,
            '-bufsize', `${bufsize}k`,
            '-hls_time', `${this.segmentTime}`,
            '-hls_list_size', '1',
            '-hls_wrap', '40',
            '-hls_start_number_source', 'datetime',
            '-preset', 'superfast',
            '-hls_segment_filename', `${segment}`,
            `${list}`
        ];
    }

    /**
     * @returns {Array<String>}
     */
    getRenditions(resolutionMask) {        
        let renditions = [];
        for (let i=0; i<RENDITIONS.length; i++) {
            if (Math.pow(2, i) & resolutionMask) {          
                renditions = renditions.concat(this.getRendition(this.timestamp, RENDITIONS[i]));
            }
        }
        return renditions;
    } 

    start() {
        return new Promise( (resolve, reject) => {    
            if (this._process) {
                return reject(`Already running`);                
            }
            
            const knownErrors = [
                'No such file or directory',
                'Invalid data found when processing input',
                'No streams to mux were specified'
            ];

            this._process = spawn(ffmpeg, this._params);

            this._process.stderr.setEncoding("utf8");
            this._process.stderr.on('data', function(data) {
                const err = data.toString();
                if (knownErrors.includes(err)) {
                    reject(err);
                }
            });

            this._process.on('error', err => {
                return reject(err);
            });
            this._process.on('close', code => {
                return resolve(code);
            });

            for(let res in this._list) {
                const listDir = path.join(this.dir, `${this.timestamp}_${res}p.m3u8`);
                fs.watchFile(listDir, (curr, prev) => {
                    if (fs.existsSync(listDir)) {
                        const list = readList(listDir);
                        this._list[res].push(list);
                    }
                });
            }
        });
    }

    stop() {
        if (this._process) {
            this._process.stdin.pause();
            this._process.kill();

            setTimeout( () => {
                for(let res in this._list) {
                    const listDir = path.join(this.dir, `${this.timestamp}_${res}p.m3u8`);
                    fs.unwatchFile(listDir);
                    fs.unlinkSync(listDir);
                }
                delete this._process;
            }, (this.segmentTime+1) * 1000); 
        }
    }
}

module.exports = class LiveStreaming {
    
    /**
     * @param {String} dir Path where segments and list are generated
     * @param {Number} resolutionMask Resolutions for multiple renditions 1:320p, 2:480p, 4:720p, 8:1080p
     * @param {Number} segmentTime Desired time in seconds for each segment
     * @param {Number} listSize Segments for each list
     */
    constructor(dir, resolutionMask = 4, segmentTime = 5, listSize = 5) {
        this._dir = dir;
        this._resolutionMask = resolutionMask;
        this._segmentTime = segmentTime;
        this._listSize = listSize;
        this._lists = [];

        // Prepare content folder
        if (fs.existsSync(dir)) {
            fs.rmdirSync(dir, {recursive:true});
        }
        fs.mkdirSync(dir);

        // Create master.m3u8 file
        const m3u8 = [];
        m3u8.push('#EXTM3U');
        m3u8.push('#EXT-X-VERSION:3');
        for (let i=0; i<RENDITIONS.length; i++) {
            if (Math.pow(2, i) & resolutionMask) {   
                const rendition = RENDITIONS[i];
                m3u8.push(`#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bitrate*1000},RESOLUTION=${rendition.width}x${rendition.height}`);
                m3u8.push(`${rendition.height}.m3u8`);
            }
        }
        fs.writeFileSync(path.join(dir, 'master.m3u8'), m3u8.join('\n'));
    }

    get dir() { return this._dir; }
    get resolutionMask() { return this._resolutionMask; }
    get renditions() { return LiveStreaming.getResolutions(this.resolutionMask); }
    get segmentTime() { return this._segmentTime; }
    get listSize() { return this._listSize; }

    emit(input) {
        return new Promise( (resolve, reject) => {
            
        })
    }
}