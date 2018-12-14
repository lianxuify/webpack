/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { HookMap, SyncBailHook } = require("tapable");

const forEachLevel = (hookMap, type, fn) => {
	const typeParts = type.split(".");
	for (let i = 0; i < typeParts.length; i++) {
		const hook = hookMap.get(typeParts.slice(i).join("."));
		if (hook) {
			const result = fn(hook);
			if (result !== undefined) return result;
		}
	}
};

class StatsFactory {
	constructor() {
		this.hooks = Object.freeze({
			/** @type {HookMap<Object, any, Object>} */
			extract: new HookMap(
				() => new SyncBailHook(["object", "data", "context"])
			),
			/** @type {HookMap<any[], Object>} */
			sort: new HookMap(() => new SyncBailHook(["items", "context"])),
			/** @type {HookMap<any, Object>} */
			getItemName: new HookMap(() => new SyncBailHook(["item", "context"])),
			/** @type {HookMap<any, Object>} */
			getItemFactory: new HookMap(() => new SyncBailHook(["item", "context"]))
		});
	}

	create(type, data, baseContext) {
		console.log("CREATE", type);
		const context = Object.assign({}, baseContext, {
			type,
			[type]: data
		});
		if (Array.isArray(data)) {
			const sortedItems = data.slice();
			forEachLevel(this.hooks.sort, type, h => h.call(sortedItems, context));
			return sortedItems.map((item, i) => {
				const itemContext = Object.assign({}, context, {
					_index: i
				});
				const itemName = forEachLevel(this.hooks.getItemName, `${type}[]`, h =>
					h.call(item, itemContext)
				);
				if (itemName) itemContext[itemName] = item;
				const innerType = itemName ? `${type}[].${itemName}` : `${type}[]`;
				const itemFactory =
					forEachLevel(this.hooks.getItemFactory, innerType, h =>
						h.call(item, itemContext)
					) || this;
				return itemFactory.create(innerType, item, itemContext);
			});
		} else {
			const object = {};
			forEachLevel(this.hooks.extract, type, h =>
				h.call(object, data, context)
			);
			return object;
		}
	}
}
module.exports = StatsFactory;
