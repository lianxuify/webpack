/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const SizeLimitsPlugin = require("../performance/SizeLimitsPlugin");
const {
	compareChunksById,
	compareNumbers,
	compareIds,
	concatComparators,
	compareSelect,
	compareModulesById,
	keepOriginalOrder
} = require("../util/comparators");

/** @typedef {import("../Compiler")} Compiler */
/** @typedef {import("../Compilation")} Compilation */
/** @typedef {import("../Module")} Module */
/** @typedef {import("webpack-sources").Source} Source */

/** @template T @typedef {Record<string, (object: Object, data: T, context: { compilation: Compilation, startTime: number, endTime: number }) => void>} ExtractorsByOption */

/**
 * @typedef {Object} SimpleExtractors
 * @property {ExtractorsByOption<Compilation>} compilation
 * @property {ExtractorsByOption<{ name: string, source: Source }>} asset
 * @property {ExtractorsByOption<Module>} module
 * @property {ExtractorsByOption<Module>} moduleIssuer
 */

/** @type {SimpleExtractors} */
const SIMPLE_EXTRACTORS = {
	compilation: {
		_: (object, compilation) => {
			if (compilation.needAdditionalPass) {
				object.needAdditionalPass = true;
			}
		},
		hash: (object, compilation) => {
			object.hash = compilation.hash;
		},
		version: object => {
			object.version = require("../../package.json").version;
		},
		timings: (object, compilation, { startTime, endTime }) => {
			object.time = endTime - startTime;
		},
		builtAt: (object, compilation, { endTime }) => {
			object.builtAt = endTime;
		},
		publicPath: (object, compilation) => {
			object.publicPath = compilation.mainTemplate.getPublicPath({
				hash: compilation.hash
			});
		},
		outputPath: (object, compilation) => {
			object.outputPath = compilation.mainTemplate.outputOptions.path;
		}
	},
	asset: {
		_: (object, asset, { compilation }) => {
			object.name = asset.name;
			object.size = asset.source.size();
			const chunks = Array.from(compilation.chunks).filter(chunk =>
				chunk.files.includes(asset.name)
			);
			object.chunks = Array.from(
				chunks.reduce((ids, chunk) => {
					for (const id of chunk.ids) {
						ids.add(id);
					}
					return ids;
				}, new Set())
			).sort(compareIds);
			object.chunkNames = Array.from(
				chunks.reduce((names, chunk) => {
					if (chunk.name) {
						names.add(chunk.name);
					}
					return names;
				}, new Set())
			).sort(compareIds);
			object.emitted = compilation.emittedAssets.has(asset.source);
		},
		performance: (object, asset) => {
			object.isOverSizeLimit = SizeLimitsPlugin.isOverSizeLimit(asset.source);
		}
	},
	module: {
		_: (object, module, context, { requestShortener }, factory) => {
			const { compilation, type } = context;
			const { chunkGraph, moduleGraph } = compilation;
			const path = [];
			const issuer = moduleGraph.getIssuer(module);
			let current = issuer;
			while (current) {
				path.push(current);
				current = moduleGraph.getIssuer(current);
			}
			path.reverse();
			Object.assign(object, {
				id: chunkGraph.getModuleId(module),
				identifier: module.identifier(),
				name: module.readableIdentifier(requestShortener),
				index: moduleGraph.getPreOrderIndex(module),
				preOrderIndex: moduleGraph.getPreOrderIndex(module),
				index2: moduleGraph.getPostOrderIndex(module),
				postOrderIndex: moduleGraph.getPostOrderIndex(module),
				size: module.size(),
				sizes: Array.from(module.getSourceTypes()).reduce((obj, type) => {
					obj[type] = module.size(type);
					return obj;
				}, {}),
				cacheable: module.buildInfo.cacheable,
				built: compilation.builtModules.has(module),
				optional: module.isOptional(moduleGraph),
				runtime: module.type === "runtime",
				chunks: Array.from(
					chunkGraph.getOrderedModuleChunksIterable(module, compareChunksById),
					chunk => chunk.id
				),
				issuer: issuer && issuer.identifier(),
				issuerId: issuer && chunkGraph.getModuleId(issuer),
				issuerName: issuer && issuer.readableIdentifier(requestShortener),
				issuerPath:
					issuer && factory.create(`${type}.issuerPath`, path, context),
				profile: factory.create(
					`${type}.profile`,
					moduleGraph.getProfile(module),
					context
				),
				failed: !!module.error,
				errors: module.errors ? module.errors.length : 0,
				warnings: module.warnings ? module.warnings.length : 0
			});
		},
		orphanModules: (object, module, { compilation, type }) => {
			if (!type.endsWith("module.modules[].module")) {
				object.orphan =
					compilation.chunkGraph.getNumberOfModuleChunks(module) === 0;
			}
		},
		moduleAssets: (object, module) => {
			object.assets = module.buildInfo.assets
				? Object.keys(module.buildInfo.assets)
				: [];
		},
		reasons: (object, module, context, options, factory) => {
			const {
				type,
				compilation: { moduleGraph }
			} = context;
			object.reasons = factory.create(
				`${type}.reasons`,
				moduleGraph.getIncomingConnections(module),
				context
			);
		},
		usedExports: (object, module, { compilation: { moduleGraph } }) => {
			const usedExports = moduleGraph.getUsedExports(module);
			if (usedExports === null) {
				object.usedExports = null;
			} else if (typeof usedExports === "boolean") {
				object.usedExports = usedExports;
			} else {
				object.usedExports = Array.from(usedExports);
			}
		},
		providedExports: (object, module) => {
			object.providedExports = Array.isArray(module.buildMeta.providedExports)
				? module.buildMeta.providedExports
				: null;
		},
		optimizationBailout: (
			object,
			module,
			{ compilation: { moduleGraph } },
			{ requestShortener }
		) => {
			object.optimizationBailout = moduleGraph
				.getOptimizationBailout(module)
				.map(item => {
					if (typeof item === "function") return item(requestShortener);
					return item;
				});
		},
		depth: (object, module, { compilation: { moduleGraph } }) => {
			object.depth = moduleGraph.getDepth(module);
		},
		nestedModules: (object, module, context, options, factory) => {
			const { type } = context;
			if (module.modules) {
				const modules = module.modules;
				object.modules = factory.create(`${type}.modules`, modules, context);
				object.filteredModules = modules.length - object.modules.length;
			}
		},
		source: (object, module) => {
			const originalSource = module.originalSource();
			if (originalSource) {
				object.source = originalSource.source();
			}
		}
	},
	moduleIssuer: {
		_: (object, module, context, { requestShortener }, factory) => {
			const { compilation, type } = context;
			const { chunkGraph, moduleGraph } = compilation;
			Object.assign(object, {
				id: chunkGraph.getModuleId(module),
				identifier: module.identifier(),
				name: module.readableIdentifier(requestShortener),
				profile: factory.create(
					`${type}.profile`,
					moduleGraph.getProfile(module),
					context
				)
			});
		}
	}
};

const iterateConfig = (config, options, fn) => {
	for (const hookFor of Object.keys(config)) {
		const subConfig = config[hookFor];
		for (const option of Object.keys(subConfig)) {
			if (option === "_" || options[option]) {
				fn(hookFor, subConfig[option]);
			}
		}
	}
};

const ITEM_NAMES = {
	"compilation.children[]": "compilation",
	"compilation.modules[]": "module",
	"chunk.modules[]": "module",
	"chunk.rootModules[]": "module",
	"compilation.chunks[]": "chunk",
	"compilation.assets[]": "asset",
	"module.issuerPath[]": "moduleIssuer"
};

class DefaultStatsFactoryPlugin {
	/**
	 * @param {Compiler} compiler webpack compiler
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap("DefaultStatsFactoryPlugin", compilation => {
			compilation.hooks.statsFactory.tap(
				"DefaultStatsFactoryPlugin",
				(stats, options, context) => {
					const { chunkGraph } = compilation;
					iterateConfig(SIMPLE_EXTRACTORS, options, (hookFor, fn) => {
						stats.hooks.extract
							.for(hookFor)
							.tap("DefaultStatsFactoryPlugin", (obj, data, ctx) =>
								fn(obj, data, ctx, options, stats)
							);
					});
					for (const key of Object.keys(ITEM_NAMES)) {
						const itemName = ITEM_NAMES[key];
						stats.hooks.getItemName
							.for(key)
							.tap("DefaultStatsFactoryPlugin", () => itemName);
					}
					if (options.modules) {
						stats.hooks.extract
							.for("compilation")
							.tap(
								"DefaultStatsFactoryPlugin",
								(object, compilation, context) => {
									const { type } = context;
									const array = Array.from(compilation.modules);
									object.modules = stats.create(
										`${type}.modules`,
										array,
										context
									);
									object.filteredModules = array.length - object.modules.length;
								}
							);
					}
					if (options.assets) {
						stats.hooks.extract
							.for("compilation")
							.tap(
								"DefaultStatsFactoryPlugin",
								(object, compilation, context) => {
									const { type } = context;
									const array = Object.keys(compilation.assets).map(name => {
										const source = compilation.assets[name];
										return {
											name,
											source
										};
									});
									object.assets = stats.create(
										`${type}.assets`,
										array,
										context
									);
									object.filteredAssets = array.length - object.assets.length;
								}
							);
					}
					if (options.chunkModules) {
						stats.hooks.extract
							.for("chunk")
							.tap("DefaultStatsFactoryPlugin", (object, chunk, context) => {
								const { type } = context;
								const array = chunkGraph.getChunkModules(chunk);
								object.modules = stats.create(
									`${type}.modules`,
									array,
									context
								);
								object.filteredModules = array.length - object.modules.length;
							});
					}
					if (options.chunkRootModules) {
						stats.hooks.extract
							.for("chunk")
							.tap("DefaultStatsFactoryPlugin", (object, chunk, context) => {
								const { type } = context;
								const array = chunkGraph.getChunkRootModules(chunk);
								object.rootModules = stats.create(
									`${type}.rootModules`,
									array,
									context
								);
								object.filteredRootModules =
									array.length - object.rootModules.length;
								object.nonRootModules =
									chunkGraph.getNumberOfChunkModules(chunk) - array.length;
							});
					}
					if (options.chunks) {
						stats.hooks.extract
							.for("compilation")
							.tap(
								"DefaultStatsFactoryPlugin",
								(object, compilation, context) => {
									const { type } = context;
									object.chunks = stats.create(
										`${type}.chunks`,
										Array.from(compilation.chunks),
										context
									);
								}
							);
					}
					if (options.children) {
						stats.hooks.extract
							.for("compilation")
							.tap("DefaultStatsFactoryPlugin", (object, comp, context) => {
								const { type } = context;
								object.children = comp.children.map((child, idx) => {
									return stats.create(
										`${type}.children`,
										comp.children,
										context
									);
								});
							});
						if (Array.isArray(options.children)) {
							stats.hooks.getItemFactory
								.for("compilation.children[].compilation")
								.tap("DefaultStatsFactoryPlugin", (comp, { _index: idx }) => {
									if (idx < options.children.length) {
										return compilation.createStatsFactory(
											compilation.createStatsOptions(
												options.children[idx],
												context
											)
										);
									}
								});
						} else if (options.children !== true) {
							const childFactory = compilation.createStatsFactory(
								compilation.createStatsOptions(options.children, context)
							);
							stats.hooks.getItemFactory
								.for("compilation.children[].compilation")
								.tap("DefaultStatsFactoryPlugin", () => {
									return childFactory;
								});
						}
					}
				}
			);
		});
	}
}
module.exports = DefaultStatsFactoryPlugin;
