/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { AsyncParallelHook, AsyncSeriesBailHook, SyncHook } = require("tapable");

class Cache {
	constructor() {
		this.hooks = {
			/** @type {AsyncSeriesBailHook<[string, string], any>} */
			get: new AsyncSeriesBailHook(["identifier", "etag"]),
			/** @type {AsyncParallelHook<[string, string, any], any>} */
			store: new AsyncParallelHook(["identifier", "etag", "data"]),
			/** @type {SyncHook<[]>} */
			beginIdle: new SyncHook([]),
			/** @type {AsyncParallelHook<[]>} */
			endIdle: new AsyncParallelHook([]),
			/** @type {AsyncParallelHook<[]>} */
			shutdown: new AsyncParallelHook([])
		};
	}

	get(identifier, etag, callback) {
		this.hooks.get.callAsync(identifier, etag, callback);
	}

	store(identifier, etag, data, callback) {
		this.hooks.store.callAsync(identifier, etag, data, callback);
	}

	beginIdle() {
		this.hooks.beginIdle.call();
	}

	endIdle(callback) {
		this.hooks.endIdle.callAsync(callback);
	}

	shutdown(callback) {
		this.hooks.shutdown.callAsync(callback);
	}
}

module.exports = Cache;
