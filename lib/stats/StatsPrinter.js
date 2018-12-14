/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { HookMap, SyncHook, SyncBailHook } = require("tapable");

/**
 * @typedef {Object} PrintedElement
 * @property {string} element
 * @property {string} content
 */

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

class StatsPrinter {
	constructor() {
		this.hooks = Object.freeze({
			/** @type {HookMap<string[], Object>} */
			sortElements: new HookMap(
				() => new SyncBailHook(["elements", "context"])
			),
			/** @type {HookMap<PrintedElement[], Object>} */
			printElements: new HookMap(
				() => new SyncBailHook(["printedElements", "context"])
			),
			/** @type {HookMap<any[], Object>} */
			sortItems: new HookMap(() => new SyncBailHook(["items", "context"])),
			/** @type {HookMap<any, Object>} */
			getItemName: new HookMap(() => new SyncBailHook(["item", "context"])),
			/** @type {HookMap<string[], Object>} */
			printItems: new HookMap(
				() => new SyncBailHook(["printedItems", "context"])
			),
			/** @type {HookMap<Object, Object>} */
			print: new HookMap(() => new SyncBailHook(["object", "context"]))
		});
	}

	print(type, object, baseContext) {
		console.log("PRINT", type, object);
		const context = Object.assign({}, baseContext, {
			type,
			[type]: object
		});

		const printResult = forEachLevel(this.hooks.print, type, hook =>
			hook.call(object, context)
		);
		if (printResult !== undefined) {
			console.log("DIRECT RESULT", printResult);
			return printResult;
		}

		if (Array.isArray(object)) {
			const sortedItems = object.slice();
			forEachLevel(this.hooks.sortItems, type, h =>
				h.call(sortedItems, context)
			);
			const printedItems = sortedItems.map((item, i) => {
				const itemContext = Object.assign({}, context, {
					_index: i
				});
				const itemName = forEachLevel(this.hooks.getItemName, `${type}[]`, h =>
					h.call(item, itemContext)
				);
				if (itemName) itemContext[itemName] = item;
				return this.print(
					itemName ? `${type}[].${itemName}` : `${type}[]`,
					item,
					itemContext
				);
			});
			const printItemsResult = forEachLevel(this.hooks.printItems, type, h =>
				h.call(printedItems, context)
			);
			if (printItemsResult !== undefined) return printItemsResult;

			const result = printedItems.filter(Boolean);
			if (result.length > 0) return result.join("\n");
		} else if (object !== null && typeof object === "object") {
			const elements = Object.keys(object);
			forEachLevel(this.hooks.sortElements, type, h =>
				h.call(elements, context)
			);
			const printedElements = elements.map(element => {
				const content = this.print(
					`${type}.${element}`,
					object[element],
					Object.assign({}, context, {
						_parent: object,
						_element: element,
						[element]: object[element]
					})
				);
				return { element, content };
			});
			console.log("PRINT ELEMENTS", printedElements);
			const printElementsResult = forEachLevel(
				this.hooks.printElements,
				type,
				h => h.call(printedElements, context)
			);
			if (printElementsResult !== undefined) return printElementsResult;

			const result = printedElements.map(e => e.content).filter(Boolean);
			if (result.length > 0) return result.join("\n");
		}
	}
}
module.exports = StatsPrinter;
