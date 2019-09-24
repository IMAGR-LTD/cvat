/*
* Copyright (C) 2019 Intel Corporation
* SPDX-License-Identifier: MIT
*/

/* global
    require:true
*/
const JSZip = require('jszip');
const JSMpeg = require('./jsmpeg');

const BlockType = Object.freeze({
    TSVIDEO: 'tsvideo',
    ARCHIVE: 'archive',
});

/* This function is a modified version of function from jsmpeg
    which converts an image from YCbCr space to RGBA space
*/
function YCbCrToRGBA(y, cb, cr, width, height) {
    const rgba = new Uint8ClampedArray(1280 * 720 * 4).fill(255);
    const w = ((width + 15) >> 4) << 4;
    const w2 = w >> 1;

    let yIndex1 = 0;
    let yIndex2 = w;
    const yNext2Lines = w + (w - width);

    let cIndex = 0;
    const cNextLine = w2 - (width >> 1);

    let rgbaIndex1 = 0;
    let rgbaIndex2 = width * 4;
    const rgbaNext2Lines = width * 4;

    const cols = width >> 1;
    const rows = height >> 1;

    let ccb = cb[0];
    let ccr = cr[0];
    let r = 0;
    let g = 0;
    let b = 0;

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            ccb = cb[cIndex];
            ccr = cr[cIndex];
            cIndex++;

            r = (ccb + ((ccb * 103) >> 8)) - 179;
            g = ((ccr * 88) >> 8) - 44 + ((ccb * 183) >> 8) - 91;
            b = (ccr + ((ccr * 198) >> 8)) - 227;

            // Line 1
            const y1 = y[yIndex1++];
            const y2 = y[yIndex1++];
            rgba[rgbaIndex1] = y1 + r;
            rgba[rgbaIndex1 + 1] = y1 - g;
            rgba[rgbaIndex1 + 2] = y1 + b;
            rgba[rgbaIndex1 + 4] = y2 + r;
            rgba[rgbaIndex1 + 5] = y2 - g;
            rgba[rgbaIndex1 + 6] = y2 + b;
            rgbaIndex1 += 8;

            // Line 2
            const y3 = y[yIndex2++];
            const y4 = y[yIndex2++];
            rgba[rgbaIndex2] = y3 + r;
            rgba[rgbaIndex2 + 1] = y3 - g;
            rgba[rgbaIndex2 + 2] = y3 + b;
            rgba[rgbaIndex2 + 4] = y4 + r;
            rgba[rgbaIndex2 + 5] = y4 - g;
            rgba[rgbaIndex2 + 6] = y4 + b;
            rgbaIndex2 += 8;
        }

        yIndex1 += yNext2Lines;
        yIndex2 += yNext2Lines;
        rgbaIndex1 += rgbaNext2Lines;
        rgbaIndex2 += rgbaNext2Lines;
        cIndex += cNextLine;
    }

    return rgba;
}

class FrameProvider {
    constructor(memory, blockType) {
        this._frames = {};
        this._memory = Math.max(1, memory); // number of stored blocks
        this._blocks = [];
        this._running = false;
        this._blockType = blockType;

        this._videoDecoder = new JSMpeg.Decoder.MPEG1Video({decodeFirstFrame : false});
        this._demuxer = new JSMpeg.Demuxer.TS({});
        this._demuxer.connect(JSMpeg.Demuxer.TS.STREAM.VIDEO_1, this._videoDecoder);

        this._currFrame = -1;
    }

    /* This method removes extra data from a cache when memory overflow */
    _cleanup() {
        if (this._blocks.length > this._memory) {
            const shifted = this._blocks.shift(); // get the oldest block
            const [start, end] = shifted.split(':').map((el) => +el);

            // remove all frames within this block
            for (let i = start; i <= end; i++) {
                delete this._frames[i];
            }
        }
    }

    _doneDecode() {
        this._running = false;
        if (this._resolvePromise) {
            const copy = this._resolvePromise;
            this._resolvePromise = null;
            copy();
        }
    }

    /* Method returns frame from collection. Else method returns 0 */
    frame(frameNumber) {
        if (frameNumber in this._frames) {
            return this._frames[frameNumber];
        }
        return null;
    }


    /*
        Method start asynchronic decode a block of data

        @param block - is a data from a server as is (ts file or archive)
        @param start {number} - is the first frame of a block
        @param end {number} - is the last frame of a block + 1
        @param callback - callback)

    */

    startDecode(block, start, end, callback) {
        if (this._running) {
            const error = new Error('Decoding has already running');
            const promise = new Promise((resolve, reject) => {
                if (this._promise) {
                    this._promise.reject();
                }

                this._promise = {
                    resolve,
                    reject,
                };
            });
            error.donePromise = promise;
            throw error;
        }

        this._running = true;
        this._blocks.push('-1:-1');

        if (this._blockType === BlockType.TSVIDEO) {
            this._demuxer.write(block);
            this._cleanup();
            this._currFrame = start;
            for (let i = start; i <= end; i++) {
                this._frames[i] = 'loading';
            }
            this._decode_id = setTimeout(
                this.decode.bind(this, start, end, callback),
                10,
            );
        } else {
            const zip = new JSZip();
            zip.loadAsync(block).then((_zip) => {
                let index = start;
                _zip.forEach((relativePath) => {
                    const fileIndex = index++;
                    _zip.file(relativePath).async('blob').then((fileData) => {
                        // Need to be sure that files
                        // are extracted one by one
                        // and don't break an order
                        const reader = new FileReader();
                        reader.onload = () => {
                            this._frames[fileIndex] = reader.result;
                            this._blocks.pop().split(':');
                            this._blocks.push(`${start}:${fileIndex}`);
                            callback(fileIndex);
                            if (fileIndex > end) {
                                this._doneDecode();
                            }
                        };
                        reader.readAsDataURL(fileData);
                    });
                });
            });
        }
    }

    /*
        Method decodes a block of data

        @param start {number} - is the first frame of a block
        @param end {number} - is the last frame of a block + 1
        @param callback - callback)

    */
    decode(start, end, callback) {
        const result = this._videoDecoder.decode();
        if (!Array.isArray(result)) {
            this._doneDecode(); // we should reset flag and resolve promise if it exist
            const message = 'Result must be an array.'
                + `Got ${result}. Possible reasons: `
                + 'bad video file, unpached jsmpeg';
            throw Error(message);
        }
        this._frames[this._currFrame] = YCbCrToRGBA(...result);
        this._blocks.pop().split(':');
        this._blocks.push(`${start}:${this._currFrame}`);
        callback(this._currFrame);
        this._currFrame++;
        if (this._currFrame > end) {
            this._doneDecode();
        } else {
            this._decode_id = setTimeout(
                this.decode.bind(this, start, end, callback),
                10,
            );
        }
    }

    /*
        Method returns a list of cached ranges
        Is an array of strings like "start:end"
    */
    get cachedFrames() {
        return [...this._blocks].sort(
            (a, b) => a.split(':')[0] - b.split(':')[0],
        );
    }
}

module.exports = {
    FrameProvider,
    BlockType,
};
