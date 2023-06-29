import { Flags, ux } from "@oclif/core";
import { readFile } from "node:fs/promises";
import { BaseCommand } from "../../../base";
import { resolvePlugin } from "../../../helpers";
import { ConfigurationJSON } from "../../../interfaces";

export class PluginList extends BaseCommand<typeof PluginList> {
	static summary = "List the installed plugins";

	static examples = [ "<%= config.bin %> <%= command.id %> -c ./apps/frontend/aetheria.json" ];

	static flags = {
		...BaseCommand.flags,
		configuration: Flags.file({
			char:        "c",
			description: "The path to the plugins configuration file",
			required:    true,
		}),
	};

	public async run(): Promise<void> {
		const plugins = await this.loadPlugins();

		ux.table(
			plugins,
			{
				name:    {
					header: "Plugin",
				},
				version: {
					header: "Version",
					get:    (row) => `v${row.version}`,
				},
			},
			{
				sort: "name",

			},
		);
	}

	/**
	 * Load the plugins from the configuration file
	 * @returns {Promise<Awaited<{name: any, version: any}>[]>} The plugins
	 */
	async loadPlugins() {
		const configuration_json = JSON.parse(await readFile(this.flags.configuration, "utf-8")) as ConfigurationJSON;

		const plugins = configuration_json.plugins.map(async (plugin) => {
			const package_json = JSON.parse(await resolvePlugin(this.flags.configuration, plugin));

			return {
				name:    package_json.name,
				version: package_json.version,
			};
		});

		return Promise.all(plugins);
	}
}
