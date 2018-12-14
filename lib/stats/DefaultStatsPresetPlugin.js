/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

/** @typedef {import("../Compiler")} Compiler */
/** @typedef {import("../Compilation")} Compilation */

const RequestShortener = require("../RequestShortener");

const applyDefaults = (options, defaults) => {
	for (const key of Object.keys(defaults)) {
		if (typeof options[key] === "undefined") {
			options[key] = defaults[key];
		}
	}
};

const NAMED_PRESETS = {
	verbose: {
		entrypoints: true,
		chunkGroups: true,
		modules: false,
		chunks: true,
		chunkModules: true,
		chunkRootModules: false,
		chunkOrigins: true,
		depth: true,
		env: true,
		reasons: true,
		usedExports: true,
		providedExports: true,
		optimizationBailout: true,
		errorDetails: true,
		publicPath: true,
		orphanModules: true,
		runtime: true,
		exclude: false,
		maxModules: Infinity
	},
	detailed: {
		entrypoints: true,
		chunkGroups: true,
		chunks: true,
		chunkModules: false,
		chunkRootModules: false,
		chunkOrigins: true,
		depth: true,
		usedExports: true,
		providedExports: true,
		optimizationBailout: true,
		errorDetails: true,
		publicPath: true,
		runtimeModules: true,
		runtime: true,
		exclude: false,
		maxModules: Infinity
	},
	minimal: {
		all: false,
		modules: true,
		maxModules: 0,
		errors: true,
		warnings: true
	},
	"errors-only": {
		all: false,
		errors: true,
		moduleTrace: true
	},
	none: {
		all: false
	}
};

const NORMAL_ON = ({ all }) => all !== false;
const NORMAL_OFF = ({ all }) => all === true;
const OFF_FOR_TO_STRING = (options, { forToString }) => !forToString;

/** @type {Record<string, (options: Object, context: { forToString: boolean }, compilation: Compilation) => any>} */
const DEFAULTS = {
	context: (options, context, compilation) => compilation.compiler.context,
	requestShortener: (options, context, compilation) =>
		compilation.compiler.context === options.context
			? compilation.requestShortener
			: new RequestShortener(options.context),
	performance: NORMAL_ON,
	hash: NORMAL_ON,
	env: NORMAL_OFF,
	version: NORMAL_ON,
	timings: NORMAL_ON,
	builtAt: NORMAL_ON,
	assets: NORMAL_ON,
	entrypoints: NORMAL_ON,
	chunkGroups: OFF_FOR_TO_STRING,
	chunks: OFF_FOR_TO_STRING,
	chunkModules: OFF_FOR_TO_STRING,
	chunkRootModules: ({ all, chunkModules }, { forToString }) =>
		forToString && all !== true ? !chunkModules : true,
	chunkOrigins: OFF_FOR_TO_STRING,
	modules: NORMAL_ON,
	nestedModules: OFF_FOR_TO_STRING,
	orphanModules: NORMAL_OFF,
	moduleAssets: OFF_FOR_TO_STRING,
	depth: OFF_FOR_TO_STRING,
	cached: NORMAL_ON,
	runtime: OFF_FOR_TO_STRING,
	cachedAssets: NORMAL_ON,
	reasons: OFF_FOR_TO_STRING,
	usedExports: OFF_FOR_TO_STRING,
	providedExports: OFF_FOR_TO_STRING,
	optimizationBailout: OFF_FOR_TO_STRING,
	children: NORMAL_ON,
	source: NORMAL_OFF,
	moduleTrace: NORMAL_ON,
	errors: NORMAL_ON,
	errorDetails: OFF_FOR_TO_STRING,
	warnings: NORMAL_ON,
	publicPath: OFF_FOR_TO_STRING,
	excludeModules: () => [],
	excludeAssets: () => [],
	maxModules: (o, { forToString }) => (forToString ? 15 : Infinity),
	modulesSort: () => "id",
	chunksSort: () => "id",
	assetsSort: () => "name",
	outputPath: OFF_FOR_TO_STRING,
	colors: () => false
};

class DefaultStatsPresetPlugin {
	/**
	 * @param {Compiler} compiler webpack compiler
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap("DefaultStatsPresetPlugin", compilation => {
			compilation.hooks.statsPreset
				.for(false)
				.tap("DefaultStatsPresetPlugin", (options, context) => {
					applyDefaults(options, NAMED_PRESETS.none);
				});
			for (const key of Object.keys(NAMED_PRESETS)) {
				const defaults = NAMED_PRESETS[key];
				compilation.hooks.statsPreset
					.for(key)
					.tap("DefaultStatsPresetPlugin", (options, context) => {
						applyDefaults(options, defaults);
					});
			}
			compilation.hooks.statsDefaults.tap(
				"DefaultStatsPresetPlugin",
				(options, context) => {
					for (const key of Object.keys(DEFAULTS)) {
						if (!DEFAULTS[key]) throw Error(key);
						if (options[key] === undefined)
							options[key] = DEFAULTS[key](options, context, compilation);
					}
				}
			);
		});
	}
}
module.exports = DefaultStatsPresetPlugin;
