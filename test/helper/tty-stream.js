'use strict';
const stream = require('stream');

class TTYStream extends stream.Writable {
	constructor(options) {
		super();

		this.isTTY = true;
		this.columns = options.columns;

		this.sanitizers = options.sanitizers || [];
		this.chunks = [];
	}

	_write(chunk, encoding, callback) {
		this.chunks.push(
			Buffer.from(this.sanitizers.reduce((str, sanitizer) => sanitizer(str), chunk.toString('utf8')), 'utf8'),
			TTYStream.SEPARATOR
		);
		callback();
	}

	asBuffer() {
		return Buffer.concat(this.chunks);
	}
}

TTYStream.SEPARATOR = Buffer.from('---tty-stream-chunk-separator\n', 'utf8');

module.exports = TTYStream;
