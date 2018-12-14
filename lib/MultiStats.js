/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

class MultiStats {
	constructor(stats) {
		this.stats = stats;
		this.hash = stats.map(stat => stat.hash).join("");
	}

	hasErrors() {
		return this.stats
			.map(stat => stat.hasErrors())
			.reduce((a, b) => a || b, false);
	}

	hasWarnings() {
		return this.stats
			.map(stat => stat.hasWarnings())
			.reduce((a, b) => a || b, false);
	}

	_createChildOptions(options, context) {
		const baseOptions = Object.keys(options)
			.filter(k => k !== "children")
			.reduce((o, k) => ((o[k] = options[k]), o), {});
		const children = this.stats.map((stat, idx) => {
			const childOptions = Array.isArray(options.children)
				? options.children[idx]
				: options.children;
			return stat.compilation.createStatsOptions(
				Object.assign(
					{},
					baseOptions,
					childOptions && typeof childOptions === "object"
						? childOptions
						: { preset: childOptions }
				),
				context
			);
		});
		const version = children.every(o => o.version);
		const hash = children.every(o => o.hash);
		if (version) {
			for (const o of children) {
				o.version = false;
			}
		}
		return {
			version,
			hash,
			children
		};
	}

	toJson(options) {
		options = this._createChildOptions(options, { forToString: false });
		const obj = {};
		obj.children = this.stats.map((stat, idx) => {
			return stat.toJson(options.children[idx]);
		});
		if (options.version) {
			obj.version = require("../package.json").version;
		}
		if (options.hash) {
			obj.hash = this.hash;
		}
		const jsons = this.stats.map((stat, idx) => {
			const childOptions = Array.isArray(options) ? options[idx] : options;
			const obj = stat.toJson(childOptions);
			obj.name = stat.compilation && stat.compilation.name;
			return obj;
		});
		obj.errors = jsons.reduce((arr, j) => {
			if (!j.errors) return arr;
			return arr.concat(
				j.errors.map(msg => {
					return `(${j.name}) ${msg}`;
				})
			);
		}, []);
		obj.warnings = jsons.reduce((arr, j) => {
			if (!j.warnings) return arr;
			return arr.concat(
				j.warnings.map(msg => {
					return `(${j.name}) ${msg}`;
				})
			);
		}, []);
		return obj;
	}

	toString(options) {
		options = this._createChildOptions(options, { forToString: true });
		const results = this.stats.map((stat, idx) => {
			return stat.toString(options.children[idx]);
		});
		if (options.version) {
			results.unshift(`Version: webpack ${require("../package.json").version}`);
		}
		if (options.hash) {
			results.unshift(`Hash: ${this.hash}`);
		}
		return results.filter(Boolean).join("\n");
	}
}

module.exports = MultiStats;
