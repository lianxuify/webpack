/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const crypto = require("crypto");
const { STAGE_ADVANCED } = require("../OptimizationStages");
const WebpackError = require("../WebpackError");
const { requestToId } = require("../ids/IdHelpers");
const { isSubset } = require("../util/SetHelpers");
const SortableSet = require("../util/SortableSet");
const {
	compareModulesByIdentifier,
	compareIterables
} = require("../util/comparators");
const deterministicGrouping = require("../util/deterministicGrouping");
const contextify = require("../util/identifier").contextify;
const MinMaxSizeWarning = require("./MinMaxSizeWarning");

/** @typedef {import("../Chunk")} Chunk */
/** @typedef {import("../ChunkGraph")} ChunkGraph */
/** @typedef {import("../Compiler")} Compiler */
/** @typedef {import("../Module")} Module */
/** @typedef {import("../ModuleGraph")} ModuleGraph */
/** @typedef {import("../util/deterministicGrouping").GroupedItems<Module>} DeterministicGroupingGroupedItemsForModule */
/** @typedef {import("../util/deterministicGrouping").Options<Module>} DeterministicGroupingOptionsForModule */

/**
 * @typedef {Object} ChunksInfoItem
 * @property {SortableSet<Module>} modules
 * @property {TODO} cacheGroup
 * @property {string} name
 * @property {boolean} validateSize
 * @property {Record<string, number>} sizes
 * @property {Set<Chunk>} chunks
 * @property {Set<Chunk>} reuseableChunks
 * @property {Set<string>} chunksKeys
 */

const deterministicGroupingForModules = /** @type {function(DeterministicGroupingOptionsForModule): DeterministicGroupingGroupedItemsForModule[]} */ (deterministicGrouping);

const hashFilename = name => {
	return crypto
		.createHash("md4")
		.update(name)
		.digest("hex")
		.slice(0, 8);
};

const getRequests = chunk => {
	let requests = 0;
	for (const chunkGroup of chunk.groupsIterable) {
		requests = Math.max(requests, chunkGroup.chunks.length);
	}
	return requests;
};

/**
 * @template T
 * @param {Set<T>} a set
 * @param {Set<T>} b other set
 * @returns {boolean} true if at least one item of a is in b
 */
const isOverlap = (a, b) => {
	for (const item of a) {
		if (b.has(item)) return true;
	}
	return false;
};

const compareModuleIterables = compareIterables(compareModulesByIdentifier);

/**
 * @param {ChunksInfoItem} a item
 * @param {ChunksInfoItem} b item
 * @returns {number} compare result
 */
const compareEntries = (a, b) => {
	// 1. by priority
	const diffPriority = a.cacheGroup.priority - b.cacheGroup.priority;
	if (diffPriority) return diffPriority;
	// 2. by number of chunks
	const diffCount = a.chunks.size - b.chunks.size;
	if (diffCount) return diffCount;
	// 3. by size reduction
	const aSizeReduce = totalSize(a.sizes) * (a.chunks.size - 1);
	const bSizeReduce = totalSize(b.sizes) * (b.chunks.size - 1);
	const diffSizeReduce = aSizeReduce - bSizeReduce;
	if (diffSizeReduce) return diffSizeReduce;
	// 4. by number of modules (to be able to compare by identifier)
	const modulesA = a.modules;
	const modulesB = b.modules;
	const diff = modulesA.size - modulesB.size;
	if (diff) return diff;
	// 5. by module identifiers
	modulesA.sort();
	modulesB.sort();
	// TODO logic is inverted: fix this
	return compareModuleIterables(modulesB, modulesA);
};

const compareNumbers = (a, b) => a - b;

const INITIAL_CHUNK_FILTER = chunk => chunk.canBeInitial();
const ASYNC_CHUNK_FILTER = chunk => !chunk.canBeInitial();
const ALL_CHUNK_FILTER = chunk => true;

const normalizeSizes = value => {
	if (typeof value === "number") {
		const obj = Object.create(null);
		obj.javascript = value;
		return obj;
	} else if (value && typeof value === "object") {
		return Object.assign(Object.create(null), value);
	} else {
		return Object.create(null);
	}
};

const mergeSizes = (value, defaultValue) => {
	if (value === undefined) return normalizeSizes(defaultValue);
	const sizes = normalizeSizes(value);
	const defaultSizes = normalizeSizes(defaultValue);
	return Object.assign(Object.create(null), defaultSizes, sizes);
};

const combineSizes = (a, b, combine) => {
	const aKeys = new Set(Object.keys(a));
	const bKeys = new Set(Object.keys(b));
	const result = Object.create(null);
	for (const key of aKeys) {
		if (bKeys.has(key)) {
			result[key] = combine(a[key], b[key]);
		} else {
			result[key] = a[key];
		}
	}
	for (const key of bKeys) {
		if (!aKeys.has(key)) {
			result[key] = b[key];
		}
	}
	return result;
};

const checkMinSize = (sizes, minSize) => {
	for (const key of Object.keys(minSize)) {
		const size = sizes[key];
		if (size === undefined) return false;
		if (size < minSize[key]) return false;
	}
	return true;
};

const totalSize = sizes => {
	let size = 0;
	for (const key of Object.keys(sizes)) {
		size += sizes[key];
	}
	return size;
};

module.exports = class SplitChunksPlugin {
	constructor(options) {
		this.options = SplitChunksPlugin.normalizeOptions(options);
	}

	static normalizeOptions(options = {}) {
		return {
			chunksFilter: SplitChunksPlugin.normalizeChunksFilter(
				options.chunks || "all"
			),
			minSize: normalizeSizes(options.minSize),
			maxSize: normalizeSizes(options.maxSize),
			minChunks: options.minChunks || 1,
			maxAsyncRequests: options.maxAsyncRequests || 1,
			maxInitialRequests: options.maxInitialRequests || 1,
			hidePathInfo: options.hidePathInfo || false,
			filename: options.filename || undefined,
			getCacheGroups: SplitChunksPlugin.normalizeCacheGroups({
				cacheGroups: options.cacheGroups,
				name: options.name
			}),
			automaticNameDelimiter: options.automaticNameDelimiter,
			fallbackCacheGroup: SplitChunksPlugin.normalizeFallbackCacheGroup(
				options.fallbackCacheGroup || {},
				options
			)
		};
	}

	static normalizeName(name) {
		if (typeof name === "string") {
			const fn = () => {
				return name;
			};
			return fn;
		}
		if (typeof name === "function") return name;
	}

	static normalizeChunksFilter(chunks) {
		if (chunks === "initial") {
			return INITIAL_CHUNK_FILTER;
		}
		if (chunks === "async") {
			return ASYNC_CHUNK_FILTER;
		}
		if (chunks === "all") {
			return ALL_CHUNK_FILTER;
		}
		if (typeof chunks === "function") return chunks;
	}

	static normalizeFallbackCacheGroup(
		{
			minSize = undefined,
			maxSize = undefined,
			automaticNameDelimiter = undefined
		},
		{
			minSize: defaultMinSize = undefined,
			maxSize: defaultMaxSize = undefined,
			automaticNameDelimiter: defaultAutomaticNameDelimiter = undefined
		}
	) {
		return {
			minSize: mergeSizes(minSize, defaultMinSize),
			maxSize: mergeSizes(maxSize, defaultMaxSize),
			automaticNameDelimiter:
				automaticNameDelimiter || defaultAutomaticNameDelimiter || "~"
		};
	}

	static normalizeCacheGroups({ cacheGroups, name }) {
		if (typeof cacheGroups === "function") {
			return cacheGroups;
		}
		if (cacheGroups && typeof cacheGroups === "object") {
			const fn = (module, context) => {
				let results;
				for (const key of Object.keys(cacheGroups)) {
					let option = cacheGroups[key];
					if (option === false) continue;
					if (option instanceof RegExp || typeof option === "string") {
						option = {
							test: option
						};
					}
					if (typeof option === "function") {
						let result = option(module);
						if (result) {
							if (results === undefined) results = [];
							for (const r of Array.isArray(result) ? result : [result]) {
								const result = Object.assign({ key }, r);
								if (result.name) result.getName = () => result.name;
								if (result.chunks) {
									result.chunksFilter = SplitChunksPlugin.normalizeChunksFilter(
										result.chunks
									);
								}
								result.minSize = normalizeSizes(result.minSize);
								result.maxSize = normalizeSizes(result.maxSize);
								results.push(result);
							}
						}
					} else if (
						SplitChunksPlugin.checkTest(option.test, module, context) &&
						SplitChunksPlugin.checkModuleType(option.type, module)
					) {
						if (results === undefined) results = [];
						results.push({
							key: key,
							priority: option.priority,
							getName:
								SplitChunksPlugin.normalizeName(option.name || name) ||
								(() => {}),
							chunksFilter: SplitChunksPlugin.normalizeChunksFilter(
								option.chunks
							),
							enforce: option.enforce,
							minSize: normalizeSizes(option.minSize),
							maxSize: normalizeSizes(option.maxSize),
							minChunks: option.minChunks,
							maxAsyncRequests: option.maxAsyncRequests,
							maxInitialRequests: option.maxInitialRequests,
							filename: option.filename,
							idHint: option.idHint,
							automaticNameDelimiter: option.automaticNameDelimiter,
							reuseExistingChunk: option.reuseExistingChunk
						});
					}
				}
				return results;
			};
			return fn;
		}
		const fn = () => {};
		return fn;
	}

	/**
	 * @typedef {Object} TestContext
	 * @property {ModuleGraph} moduleGraph the module graph
	 * @property {ChunkGraph} chunkGraph the chunk graph
	 */

	/**
	 * @param {undefined|boolean|string|RegExp|function(Module, TestContext): boolean} test test option
	 * @param {Module} module the module
	 * @param {TestContext} context context object
	 * @returns {boolean} true, if the module should be selected
	 */
	static checkTest(test, module, context) {
		if (test === undefined) return true;
		if (typeof test === "function") {
			return test(module, context);
		}
		if (typeof test === "boolean") return test;
		if (typeof test === "string") {
			const name = module.nameForCondition();
			return name && name.startsWith(test);
		}
		if (test instanceof RegExp) {
			const name = module.nameForCondition();
			return name && test.test(name);
		}
		return false;
	}
	/**
	 * @param {undefined|string|RegExp|function(string): boolean} test type option
	 * @param {Module} module the module
	 * @returns {boolean} true, if the module should be selected
	 */
	static checkModuleType(test, module) {
		if (test === undefined) return true;
		if (typeof test === "function") {
			return test(module.type);
		}
		if (typeof test === "string") {
			const type = module.type;
			return test === type;
		}
		if (test instanceof RegExp) {
			const type = module.type;
			return test.test(type);
		}
		return false;
	}

	/**
	 * @param {Compiler} compiler webpack compiler
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.thisCompilation.tap("SplitChunksPlugin", compilation => {
			let alreadyOptimized = false;
			compilation.hooks.unseal.tap("SplitChunksPlugin", () => {
				alreadyOptimized = false;
			});
			compilation.hooks.optimizeChunks.tap(
				{
					name: "SplitChunksPlugin",
					stage: STAGE_ADVANCED
				},
				chunks => {
					if (alreadyOptimized) return;
					alreadyOptimized = true;
					const chunkGraph = compilation.chunkGraph;
					const moduleGraph = compilation.moduleGraph;
					// Give each selected chunk an index (to create strings from chunks)
					const indexMap = new Map();
					let index = 1;
					for (const chunk of chunks) {
						indexMap.set(chunk, index++);
					}
					const getKey = chunks => {
						return Array.from(chunks, c => indexMap.get(c))
							.sort(compareNumbers)
							.join();
					};
					/** @type {Map<string, Set<Chunk>>} */
					const chunkSetsInGraph = new Map();
					for (const module of compilation.modules) {
						const chunksKey = getKey(
							chunkGraph.getModuleChunksIterable(module)
						);
						if (!chunkSetsInGraph.has(chunksKey)) {
							chunkSetsInGraph.set(
								chunksKey,
								new Set(chunkGraph.getModuleChunksIterable(module))
							);
						}
					}

					// group these set of chunks by count
					// to allow to check less sets via isSubset
					// (only smaller sets can be subset)
					/** @type {Map<number, Array<Set<Chunk>>>} */
					const chunkSetsByCount = new Map();
					for (const chunksSet of chunkSetsInGraph.values()) {
						const count = chunksSet.size;
						let array = chunkSetsByCount.get(count);
						if (array === undefined) {
							array = [];
							chunkSetsByCount.set(count, array);
						}
						array.push(chunksSet);
					}

					// Create a list of possible combinations
					const combinationsCache = new Map(); // Map<string, Set<Chunk>[]>

					const getCombinations = key => {
						const chunksSet = chunkSetsInGraph.get(key);
						var array = [chunksSet];
						if (chunksSet.size > 1) {
							for (const [count, setArray] of chunkSetsByCount) {
								// "equal" is not needed because they would have been merge in the first step
								if (count < chunksSet.size) {
									for (const set of setArray) {
										if (isSubset(chunksSet, set)) {
											array.push(set);
										}
									}
								}
							}
						}
						return array;
					};

					/**
					 * @typedef {Object} SelectedChunksResult
					 * @property {Chunk[]} chunks the list of chunks
					 * @property {string} key a key of the list
					 */

					/**
					 * @typedef {function(Chunk): boolean} ChunkFilterFunction
					 */

					/** @type {WeakMap<Set<Chunk>, WeakMap<ChunkFilterFunction, SelectedChunksResult>>} */
					const selectedChunksCacheByChunksSet = new WeakMap();

					/**
					 * get list and key by applying the filter function to the list
					 * It is cached for performance reasons
					 * @param {Set<Chunk>} chunks list of chunks
					 * @param {ChunkFilterFunction} chunkFilter filter function for chunks
					 * @returns {SelectedChunksResult} list and key
					 */
					const getSelectedChunks = (chunks, chunkFilter) => {
						let entry = selectedChunksCacheByChunksSet.get(chunks);
						if (entry === undefined) {
							entry = new WeakMap();
							selectedChunksCacheByChunksSet.set(chunks, entry);
						}
						/** @type {SelectedChunksResult} */
						let entry2 = entry.get(chunkFilter);
						if (entry2 === undefined) {
							/** @type {Chunk[]} */
							const selectedChunks = [];
							for (const chunk of chunks) {
								if (chunkFilter(chunk)) selectedChunks.push(chunk);
							}
							entry2 = {
								chunks: selectedChunks,
								key: getKey(selectedChunks)
							};
							entry.set(chunkFilter, entry2);
						}
						return entry2;
					};

					/** @type {Set<string>} */
					const alreadyValidatedNames = new Set();

					// Map a list of chunks to a list of modules
					// For the key the chunk "index" is used, the value is a SortableSet of modules
					/** @type {Map<string, ChunksInfoItem>} */
					const chunksInfoMap = new Map();

					/**
					 * @param {TODO} cacheGroup the current cache group
					 * @param {Chunk[]} selectedChunks chunks selected for this module
					 * @param {string} selectedChunksKey a key of selectedChunks
					 * @param {Module} module the current module
					 * @returns {void}
					 */
					const addModuleToChunksInfoMap = (
						cacheGroup,
						selectedChunks,
						selectedChunksKey,
						module
					) => {
						// Break if minimum number of chunks is not reached
						if (selectedChunks.length < cacheGroup.minChunks) return;
						// Determine name for split chunk
						const name = cacheGroup.getName(
							module,
							selectedChunks,
							cacheGroup.key
						);
						// Check if the name is ok
						if (!alreadyValidatedNames.has(name)) {
							alreadyValidatedNames.add(name);
							if (compilation.namedChunks.has(name)) {
								compilation.errors.push(
									new WebpackError(
										"SplitChunksPlugin\n" +
											`Cache group "${
												cacheGroup.key
											}" conflicts with existing chunk.\n` +
											`Both have the same name "${name}".\n` +
											"Use a different name for the cache group.\n" +
											'HINT: You can omit "name" to automatically create a name.\n' +
											"BREAKING CHANGE: webpack < 5 used to allow to use the " +
											"entrypoint as splitChunk. This is no longer allowed. " +
											"Remove this entrypoint and add modules to cache group's 'test' instead. " +
											"If you need modules to be evaluated on startup, add them to the existing entrypoints (make them arrays). " +
											"See migration guide of more info."
									)
								);
							}
						}
						// Create key for maps
						// When it has a name we use the name as key
						// Elsewise we create the key from chunks and cache group key
						// This automatically merges equal names
						const key =
							cacheGroup.key +
							(name ? ` name:${name}` : ` chunks:${selectedChunksKey}`);
						// Add module to maps
						let info = chunksInfoMap.get(key);
						if (info === undefined) {
							chunksInfoMap.set(
								key,
								(info = {
									modules: new SortableSet(
										undefined,
										compareModulesByIdentifier
									),
									cacheGroup,
									name,
									validateSize: Object.keys(cacheGroup.minSize).length > 0,
									sizes: {},
									chunks: new Set(),
									reuseableChunks: new Set(),
									chunksKeys: new Set()
								})
							);
						}
						info.modules.add(module);
						if (info.validateSize) {
							for (const type of module.getSourceTypes()) {
								info.sizes[type] = (info.sizes[type] || 0) + module.size(type);
							}
						}
						if (!info.chunksKeys.has(selectedChunksKey)) {
							info.chunksKeys.add(selectedChunksKey);
							for (const chunk of selectedChunks) {
								info.chunks.add(chunk);
							}
						}
					};

					const context = {
						moduleGraph,
						chunkGraph
					};

					// Walk through all modules
					for (const module of compilation.modules) {
						// Get cache group
						let cacheGroups = this.options.getCacheGroups(module, context);
						if (!Array.isArray(cacheGroups) || cacheGroups.length === 0) {
							continue;
						}

						// Prepare some values
						const chunksKey = getKey(
							chunkGraph.getModuleChunksIterable(module)
						);
						let combs = combinationsCache.get(chunksKey);
						if (combs === undefined) {
							combs = getCombinations(chunksKey);
							combinationsCache.set(chunksKey, combs);
						}

						for (const cacheGroupSource of cacheGroups) {
							const cacheGroup = {
								key: cacheGroupSource.key,
								priority: cacheGroupSource.priority || 0,
								chunksFilter:
									cacheGroupSource.chunksFilter || this.options.chunksFilter,
								minSize: mergeSizes(
									cacheGroupSource.minSize,
									cacheGroupSource.enforce
										? Object.create(null)
										: this.options.minSize
								),
								minSizeForMaxSize: mergeSizes(
									cacheGroupSource.minSize,
									this.options.minSize
								),
								maxSize: mergeSizes(
									cacheGroupSource.maxSize,
									cacheGroupSource.enforce
										? Object.create(null)
										: this.options.maxSize
								),
								minChunks:
									cacheGroupSource.minChunks !== undefined
										? cacheGroupSource.minChunks
										: cacheGroupSource.enforce
											? 1
											: this.options.minChunks,
								maxAsyncRequests:
									cacheGroupSource.maxAsyncRequests !== undefined
										? cacheGroupSource.maxAsyncRequests
										: cacheGroupSource.enforce
											? Infinity
											: this.options.maxAsyncRequests,
								maxInitialRequests:
									cacheGroupSource.maxInitialRequests !== undefined
										? cacheGroupSource.maxInitialRequests
										: cacheGroupSource.enforce
											? Infinity
											: this.options.maxInitialRequests,
								getName:
									cacheGroupSource.getName !== undefined
										? cacheGroupSource.getName
										: this.options.getName,
								filename:
									cacheGroupSource.filename !== undefined
										? cacheGroupSource.filename
										: this.options.filename,
								automaticNameDelimiter:
									cacheGroupSource.automaticNameDelimiter !== undefined
										? cacheGroupSource.automaticNameDelimiter
										: this.options.automaticNameDelimiter,
								idHint:
									cacheGroupSource.idHint !== undefined
										? cacheGroupSource.idHint
										: cacheGroupSource.key,
								reuseExistingChunk: cacheGroupSource.reuseExistingChunk
							};
							// For all combination of chunk selection
							for (const chunkCombination of combs) {
								// Break if minimum number of chunks is not reached
								if (chunkCombination.size < cacheGroup.minChunks) continue;
								// Select chunks by configuration
								const {
									chunks: selectedChunks,
									key: selectedChunksKey
								} = getSelectedChunks(
									chunkCombination,
									cacheGroup.chunksFilter
								);

								addModuleToChunksInfoMap(
									cacheGroup,
									selectedChunks,
									selectedChunksKey,
									module
								);
							}
						}
					}

					// Filter items were size < minSize
					for (const pair of chunksInfoMap) {
						const info = pair[1];
						if (
							info.validateSize &&
							!checkMinSize(info.sizes, info.cacheGroup.minSize)
						) {
							chunksInfoMap.delete(pair[0]);
						}
					}

					/** @type {Map<Chunk, {minSize: Record<string, number>, maxSize: Record<string, number>, automaticNameDelimiter: string, keys: string[]}>} */
					const maxSizeQueueMap = new Map();

					while (chunksInfoMap.size > 0) {
						// Find best matching entry
						let bestEntryKey;
						let bestEntry;
						for (const pair of chunksInfoMap) {
							const key = pair[0];
							const info = pair[1];
							if (bestEntry === undefined) {
								bestEntry = info;
								bestEntryKey = key;
							} else if (compareEntries(bestEntry, info) < 0) {
								bestEntry = info;
								bestEntryKey = key;
							}
						}

						const item = bestEntry;
						chunksInfoMap.delete(bestEntryKey);

						let chunkName = item.name;
						// Variable for the new chunk (lazy created)
						/** @type {Chunk} */
						let newChunk;
						// When no chunk name, check if we can reuse a chunk instead of creating a new one
						let isReused = false;
						if (item.cacheGroup.reuseExistingChunk) {
							outer: for (const chunk of item.chunks) {
								if (
									chunkGraph.getNumberOfChunkModules(chunk) !==
									item.modules.size
								)
									continue;
								if (chunkGraph.getNumberOfEntryModules(chunk) > 0) continue;
								for (const module of item.modules) {
									if (!chunkGraph.isModuleInChunk(module, chunk))
										continue outer;
								}
								if (!newChunk || !newChunk.name) {
									newChunk = chunk;
								} else if (
									chunk.name &&
									chunk.name.length < newChunk.name.length
								) {
									newChunk = chunk;
								} else if (
									chunk.name &&
									chunk.name.length === newChunk.name.length &&
									chunk.name < newChunk.name
								) {
									newChunk = chunk;
								}
								chunkName = undefined;
								isReused = true;
							}
						}
						// Check if maxRequests condition can be fulfilled

						const usedChunks = Array.from(item.chunks).filter(chunk => {
							// skip if we address ourself
							return (
								(!chunkName || chunk.name !== chunkName) && chunk !== newChunk
							);
						});

						// Skip when no chunk selected
						if (usedChunks.length === 0 && !isReused) continue;

						if (
							Number.isFinite(item.cacheGroup.maxInitialRequests) ||
							Number.isFinite(item.cacheGroup.maxAsyncRequests)
						) {
							const chunksInLimit = usedChunks.filter(chunk => {
								// respect max requests when not enforced
								const maxRequests = chunk.isOnlyInitial()
									? item.cacheGroup.maxInitialRequests
									: chunk.canBeInitial()
										? Math.min(
												item.cacheGroup.maxInitialRequests,
												item.cacheGroup.maxAsyncRequests
										  )
										: item.cacheGroup.maxAsyncRequests;
								return (
									!isFinite(maxRequests) || getRequests(chunk) < maxRequests
								);
							});

							if (isReused) chunksInLimit.push(newChunk);

							if (chunksInLimit.length < usedChunks.length) {
								if (chunksInLimit.length >= item.cacheGroup.minChunks) {
									for (const module of item.modules) {
										addModuleToChunksInfoMap(
											item.cacheGroup,
											chunksInLimit,
											getKey(chunksInLimit),
											module
										);
									}
								}
								continue;
							}
						}

						// Create the new chunk if not reusing one
						if (!isReused) {
							newChunk = compilation.addChunk(chunkName);
						}
						// Walk through all chunks
						for (const chunk of usedChunks) {
							// Add graph connections for splitted chunk
							chunk.split(newChunk);
						}

						// Add a note to the chunk
						newChunk.chunkReason = isReused
							? "reused as split chunk"
							: "split chunk";
						if (item.cacheGroup.key) {
							newChunk.chunkReason += ` (cache group: ${item.cacheGroup.key})`;
						}
						if (chunkName) {
							newChunk.chunkReason += ` (name: ${chunkName})`;
							// If the chosen name is already an entry point we remove the entry point
							const entrypoint = compilation.entrypoints.get(chunkName);
							if (entrypoint) {
								compilation.entrypoints.delete(chunkName);
								entrypoint.remove();
								chunkGraph.disconnectEntries(newChunk);
							}
						}
						if (item.cacheGroup.filename) {
							if (!newChunk.isOnlyInitial()) {
								throw new Error(
									"SplitChunksPlugin: You are trying to set a filename for a chunk which is (also) loaded on demand. " +
										"The runtime can only handle loading of chunks which match the chunkFilename schema. " +
										"Using a custom filename would fail at runtime. " +
										`(cache group: ${item.cacheGroup.key})`
								);
							}
							newChunk.filenameTemplate = item.cacheGroup.filename;
						}
						if (item.cacheGroup.idHint) {
							newChunk.idNameHints.add(item.cacheGroup.idHint);
						}
						if (!isReused) {
							// Add all modules to the new chunk
							for (const module of item.modules) {
								if (!module.chunkCondition(newChunk, compilation)) continue;
								// Add module to new chunk
								chunkGraph.connectChunkAndModule(newChunk, module);
								// Remove module from used chunks
								for (const chunk of usedChunks) {
									chunkGraph.disconnectChunkAndModule(chunk, module);
								}
							}
						} else {
							// Remove all modules from used chunks
							for (const module of item.modules) {
								for (const chunk of usedChunks) {
									chunkGraph.disconnectChunkAndModule(chunk, module);
								}
							}
						}

						if (Object.keys(item.cacheGroup.maxSize).length > 0) {
							const oldMaxSizeSettings = maxSizeQueueMap.get(newChunk);
							maxSizeQueueMap.set(newChunk, {
								minSize: oldMaxSizeSettings
									? combineSizes(
											oldMaxSizeSettings.minSize,
											item.cacheGroup.minSizeForMaxSize,
											Math.max
									  )
									: item.cacheGroup.minSize,

								maxSize: oldMaxSizeSettings
									? combineSizes(
											oldMaxSizeSettings.maxSize,
											item.cacheGroup.maxSize,
											Math.min
									  )
									: item.cacheGroup.maxSize,

								automaticNameDelimiter: item.cacheGroup.automaticNameDelimiter,
								keys: oldMaxSizeSettings
									? oldMaxSizeSettings.keys.concat(item.cacheGroup.key)
									: [item.cacheGroup.key]
							});
						}

						// remove all modules from other entries and update size
						for (const [key, info] of chunksInfoMap) {
							if (isOverlap(info.chunks, item.chunks)) {
								if (info.validateSize) {
									// update modules and total size
									// may remove it from the map when < minSize
									let updated = false;
									for (const module of item.modules) {
										if (info.modules.has(module)) {
											// remove module
											info.modules.delete(module);
											// update size
											for (const key of module.getSourceTypes()) {
												info.sizes[key] -= module.size(key);
											}
											updated = true;
										}
									}
									if (updated) {
										if (info.modules.size === 0) {
											chunksInfoMap.delete(key);
											continue;
										}
										if (!checkMinSize(info.sizes, info.cacheGroup.minSize)) {
											chunksInfoMap.delete(key);
										}
									}
								} else {
									// only update the modules
									for (const module of item.modules) {
										info.modules.delete(module);
									}
									if (info.modules.size === 0) {
										chunksInfoMap.delete(key);
									}
								}
							}
						}
					}

					const incorrectMinMaxSizeSet = new Set();

					// Make sure that maxSize is fulfilled
					for (const chunk of Array.from(compilation.chunks)) {
						const chunkConfig = maxSizeQueueMap.get(chunk);
						const { minSize, maxSize, automaticNameDelimiter } =
							chunkConfig || this.options.fallbackCacheGroup;
						if (!maxSize || Object.keys(maxSize).length === 0) continue;
						for (const key of Object.keys(maxSize)) {
							const maxSizeValue = maxSize[key];
							const minSizeValue = minSize[key];
							if (
								typeof minSizeValue === "number" &&
								minSizeValue > maxSizeValue
							) {
								const keys = chunkConfig && chunkConfig.keys;
								const warningKey = `${keys &&
									keys.join()} ${minSizeValue} ${maxSizeValue}`;
								if (!incorrectMinMaxSizeSet.has(warningKey)) {
									incorrectMinMaxSizeSet.add(warningKey);
									compilation.warnings.push(
										new MinMaxSizeWarning(keys, minSizeValue, maxSizeValue)
									);
								}
							}
						}
						const results = deterministicGroupingForModules({
							maxSize: Object.keys(maxSize).reduce((obj, key) => {
								const minSizeValue = minSize[key];
								obj[key] =
									typeof minSizeValue === "number"
										? Math.max(maxSize[key], minSizeValue)
										: maxSize[key];
								return obj;
							}, Object.create(null)),
							minSize,
							items: chunkGraph.getChunkModulesIterable(chunk),
							getKey(module) {
								const ident = contextify(
									compilation.options.context,
									module.identifier()
								);
								const nameForCondition =
									module.nameForCondition && module.nameForCondition();
								const name = nameForCondition
									? contextify(compilation.options.context, nameForCondition)
									: ident.replace(/^.*!|\?[^?!]*$/g, "");
								const fullKey =
									name + automaticNameDelimiter + hashFilename(ident);
								return requestToId(fullKey);
							},
							getSize(module) {
								const size = Object.create(null);
								for (const key of module.getSourceTypes())
									size[key] = module.size(key);
								return size;
							}
						});
						if (results.length === 0) continue;
						results.sort((a, b) => {
							if (a.key < b.key) return -1;
							if (a.key > b.key) return 1;
							return 0;
						});
						for (let i = 0; i < results.length; i++) {
							const group = results[i];
							const key = this.options.hidePathInfo
								? hashFilename(group.key)
								: group.key;
							let name = chunk.name
								? chunk.name + automaticNameDelimiter + key
								: null;
							if (name && name.length > 100) {
								name =
									name.slice(0, 100) +
									automaticNameDelimiter +
									hashFilename(name);
							}
							let newPart;
							if (i !== results.length - 1) {
								newPart = compilation.addChunk(name);
								chunk.split(newPart);
								newPart.chunkReason = chunk.chunkReason;
								// Add all modules to the new chunk
								for (const module of group.items) {
									if (!module.chunkCondition(newPart, compilation)) continue;
									// Add module to new chunk
									chunkGraph.connectChunkAndModule(newPart, module);
									// Remove module from used chunks
									chunkGraph.disconnectChunkAndModule(chunk, module);
								}
							} else {
								// change the chunk to be a part
								newPart = chunk;
								chunk.name = name;
							}
						}
					}
				}
			);
		});
	}
};
