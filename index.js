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

/**
 * Read a m3u8 list and returns its parameters
 * @param {String} destinationPath List to read path
 * @returns {Object} Basic information of each segment and list moment
 */
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

/**
 * Write a clean list with selected parameters
 * @param {String} fileDir List save path
 * @param {String} url Optional url for http streaming
 * @param {Object} list List parameters
 */
function writeMasterList(fileDir, url, {duration, sequence, segments}) {
    const m3u8 = [];
    m3u8.push('#EXTM3U');
    m3u8.push('#EXT-X-VERSION:3');
    m3u8.push('#EXT-X-ALLOW-CACHE:YES');
    m3u8.push(`#EXT-X-TARGETDURATION:${duration}`);
    m3u8.push(`#EXT-X-MEDIA-SEQUENCE:${sequence}`);
    /*if (segments.find(s => s.discontinuity)) {
        m3u8.push('#EXT-X-DISCONTINUITY-SEQUENCE:0');
    }*/
    for(let i=0; i<segments.length; i++) {
        const segment = segments[i];
        if (segment.discontinuity) {
            m3u8.push('#EXT-X-DISCONTINUITY');
        }
        m3u8.push(`#EXTINF:${segment.duration},`);
        const file = url ? new URL(segment.file, url).href : segment.file;
        m3u8.push(file);
    }
    fs.writeFileSync(fileDir, m3u8.join('\n'));
}

/**
 * Used to start an emission using ffmpeg and monit output events
 */
class Emission {
    /**
     * @param {String} dir Segments and list build path
     * @param {String} input Input to stream
     * @param {Number} segmentTime Desired time of each segment
     * @param {Number} listSize List size
     * @param {Number} resolutionMask Resolution mask
     * @param {Function<Emission, String} onWrite Called when a new segment is created
     */
    constructor(dir, input, segmentTime, listSize, resolutionMask, onWrite) {
        this._dir = dir;
        this._input = input;
        this._segmentTime = segmentTime;        
        this._listSize = listSize;
        this._timestamp = Date.now().toString();
        this._params = ['-re', '-i', `${input}`].concat(this.getRenditions(resolutionMask));
        this._onWrite = onWrite;
        this._list = [];
        for (let i=0; i<RENDITIONS.length; i++) {
            if (Math.pow(2, i) & resolutionMask) {   
                const rendition = RENDITIONS[i];
                this._list[`${rendition.height}p`] = [];
            }
        }
    }

    get dir() { return this._dir; }
    get input() { return this._input; }
    get segmentTime() { return this._segmentTime; }
    get listSize() { return this._listSize; }
    get timestamp() { return this._timestamp; }

    /**
     * Get parameters for spawn call of a given rendition
     * @param {Object} rendition Rendition
     * @returns {Array<String>} Parameters for the spawn call
     */
    getRendition({width, height, audiorate, bitrate, maxrate, bufsize}) {
        const segment = path.join(this.dir, `${height}p_%04d.ts`);
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
            '-start_number', '0',
            //'-hls_start_number_source', 'datetime',
            '-preset', 'superfast',
            '-hls_segment_filename', `${segment}`,
            `${list}`
        ];
    }

    /**
     * Get all renditions parameters of a given resolution mask
     * @param {Number} resolutionMask Resolution mask to generate renditions
     * @returns {Array<String>} Parameters for the spawn call
     */
    getRenditions(resolutionMask) {        
        let renditions = [];
        for (let i=0; i<RENDITIONS.length; i++) {
            if (Math.pow(2, i) & resolutionMask) {          
                renditions = renditions.concat(this.getRendition(RENDITIONS[i]));
            }
        }
        return renditions;
    } 

    /**
     * Starts the emission
     * @returns {Promise} The promise to start the emission
     */
    start() {
        return new Promise( (resolve, reject) => {
            if (this._process) {
                return reject(`Already in transition`);
            }
            
            const knownErrors = [
                'Invalid argument',
                'No such file or directory',
                'Invalid data found when processing input',
                'No streams to mux were specified'
            ];

            this._process = spawn(ffmpeg, this._params);

            this._process.stderr.setEncoding("utf8");
            this._process.stderr.on('data', function(data) {
                const output = data.toString().split('\r\n');
                for(let error of knownErrors) {
                    if (output.includes(error)) {
                        return reject(error);
                    }
                }
            });

            this._process.on('error', err => {
                return reject(err);
            });
            this._process.on('close', code => {
                return resolve(this, code);
            });

            for(let res in this._list) {
                const listDir = path.join(this.dir, `${this.timestamp}_${res}.m3u8`);
                fs.watchFile(listDir, (curr, prev) => {
                    if (fs.existsSync(listDir)) {
                        const list = readList(listDir);
                        this._list[res].push(list);
                        this._onWrite(this, res);
                    }
                });
            }
        });
    }

    /**
     * Stops the emission softly
     */
    stop() {
        if (this._process) {
            this._process.stdin.pause();
            this._process.kill();
        }
    }

    /**
     * Exists any pending segment in any resolution list
     * @returns {Boolean} 
     */
    get isEmpty() {
        for(let res in this._list) {
            if (this._list[res].length > 0) {
                return false;
            }            
        }
        return true;
    }    

    /**
     * Removes emitted file and list if is empty
     * @param {String} res Given resolution
     * @returns {Boolean} True if the resolution list is empty
     */
    dispose(res) {
        if (this._list[res].length > 0) {
            const item = this._list[res].splice(0, 1)[0];
            if (item) {
                const segDir = path.join(this.dir, item.segment.file);
                if (fs.existsSync(segDir)) fs.unlinkSync(segDir);
            }
            if (this._list[res].length < 1) {
                const listDir = path.join(this.dir, `${this.timestamp}_${res}.m3u8`);
                fs.unwatchFile(listDir);
                if (fs.existsSync(listDir)) fs.unlinkSync(listDir);
                return true;
            }
        }
        return false;
    }

    /**
     * Delete all current files and lists of all resolutions
     */
    disposeAll() {
        for(let res in this._list) {
            for (let item of this._list[res]) {
                const segDir = path.join(this.dir, item.segment.file);
                if (fs.existsSync(segDir)) fs.unlinkSync(segDir);
            }
            const listDir = path.join(this.dir, `${this.timestamp}_${res}.m3u8`);
            fs.unwatchFile(listDir);
            if (fs.existsSync(listDir)) fs.unlinkSync(listDir);
        }
    }
}

/**
 * Main class to control file streaming and emission queue
 */
module.exports = class FileStreaming {
    
    /**
     * @param {String} dir Path where segments and list are generated
     * @param {Number} resolutionMask Resolutions for multiple renditions 1:320p, 2:480p, 4:720p, 8:1080p
     * @param {Number} segmentTime Desired time in seconds for each segment
     * @param {Number} listSize Segments for each list
     */
    constructor(dir, url, resolutionMask = 4, segmentTime = 5, listSize = 5) {
        this._dir = dir;
        this._url = url;
        this._resolutionMask = resolutionMask;
        this._segmentTime = segmentTime;
        this._listSize = listSize;

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
                let file = `${rendition.height}p.m3u8`;
                if (url) {
                    file = new URL(file, url).href;
                }
                m3u8.push(file);
            }
        }
        fs.writeFileSync(path.join(dir, 'master.m3u8'), m3u8.join('\n'));
    }

    get dir() { return this._dir; }
    get url() { return this._url; }
    get resolutionMask() { return this._resolutionMask; }
    get renditions() { return LiveStreaming.getResolutions(this.resolutionMask); }
    get segmentTime() { return this._segmentTime; }
    get listSize() { return this._listSize; }

    /**
     * Starts an emission interrupting the current
     * @param {String} input Input to stream
     * @returns {Promise<Emission>} Promise to start the emission
     */
    emit(input) {
        return new Promise( (resolve, reject) => {            

            if (this._last) {
                return reject('Transition in progress');
            }

            const emission = new Emission(this.dir, input, this.segmentTime, this.listSize, this.resolutionMask, 
            (e, r) => {
                if (!this._current) {
                    this._current = e;
                }
                else if (e !== this._current && e.timestamp > this._current.timestamp) {
                    this._last = this._current;
                    this._current = e;
                    this._last.stop();           
                }

                let list = [];
                if (this._last) {
                    for(let li of this._last.list[r]) {
                        list.push({
                            emission: this._last,
                            duration: li.duration,
                            sequence: li.sequence,
                            segment: li.segment
                        });                        
                    }
                }
                for(let li of this._current.list[r]) {
                    list.push({
                        emission: this._current,
                        duration: li.duration,
                        sequence: li.sequence,
                        segment: {
                            duration: li.segment.duration,
                            file: li.segment.file,
                        }
                    });
                }

                const dif = list.length - this.listSize;
                if (dif > 0) {
                    const markToDispose = list.splice(0, dif);
                    for(let item of markToDispose) {
                        if (item.emission.dispose(r)) {
                            if (item.emission.isEmpty) {
                                if (item.emission === this._last) delete this._last;
                                if (item.emission === this._current) delete this._current;
                            }
                        }
                    }
                }

                if (list.find(l => l.emission === this._last)) {
                    const first = list.find(l => l.emission === this._current);
                    first.segment.discontinuity = true;
                }
                list = {
                    duration: Math.max(...list.map(o => o.duration), 0),
                    sequence: list[0].sequence,
                    segments: list.map(l => l.segment)
                };   
                const fileDir = path.join(this.dir, `${r}.m3u8`);
                writeMasterList(fileDir, this.url, list);
            });

            emission.start()
            .then(resolve)
            .catch(reject);
        });
    }

    /**
     * Stops the emissions
     */
    stop() {
        if (this._last) {
            this._last.stop();
            this._last.disposeAll();
        }
        if (this._current) {
            this._current.stop();
            this._current.disposeAll();
        }
    }
}