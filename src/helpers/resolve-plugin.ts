import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { PluginReference } from "../interfaces";

/**
 * Resolve the plugin from the configuration file to a package.json file.
 * Try to resolve the plugin in the following order:
 * 1. The path specified in the configuration file
 * 2. The node_modules directory
 * 3. The path specified in the configuration file relative to the node_modules directory
 *
 * The first one to resolve is returned. If none resolve, an error is thrown.
 *
 * @param configuration_path The path to the configuration file
 * @param {PluginReference} plugin The plugin to resolve
 * @returns {Promise<Awaited<Promise<string>[][number]>>} The resolved plugin
 * @private
 */
export function resolvePlugin(configuration_path: string, plugin: PluginReference) {
	return Promise.any([
		readFile(resolve(configuration_path, plugin.resolve, "package.json"), "utf-8"),
		readFile(resolve(cwd(), "node_modules", plugin.id, "package.json"), "utf-8"),
		readFile(resolve(cwd(), "node_modules", plugin.resolve, "package.json"), "utf-8"),
	]);
}
