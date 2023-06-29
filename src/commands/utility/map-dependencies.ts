import { Flags } from "@oclif/core";
import { Dirent } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BaseCommand } from "../../base";

export class MapDependencies extends BaseCommand<typeof MapDependencies> {
	static summary = "Map the dependencies of the project and write them to the package.json";

	static examples = [ "<%= config.bin %> <%= command.id %>" ];

	static flags = {
		...BaseCommand.flags,
		target:            Flags.string({
			char:        "t",
			description: "The target package.json to map the dependencies for",
			required:    true,
		}),
		base_package_json: Flags.string({
			char:        "b",
			description: "The base package.json used to extract the dependencies",
			required:    true,
		}),
		tsconfig:          Flags.string({
			char:        "T",
			description: "The tsconfig.json to use for the project to resolve local dependencies",
		}),
	};

	protected target_package_json!: Record<string, string>;

	public async run(): Promise<any> {
		if (!this.flags.tsconfig) {
			this.warn("No tsconfig.json provided, local dependencies will not be resolved");
		}

		const [ raw_dependencies, base_dependencies, files, local_dependencies ] = await Promise.all([
			this.loadDependencies(this.flags.target),
			this.loadDependencies(this.flags.base_package_json),
			this.getFiles(this.flags.target.replace("package.json", "")),
			this.loadLocalDependencies(),
		]);

		const dependencies = Object.keys(raw_dependencies).length === 0
			? new Set<string>([])
			: new Set(Object.keys(raw_dependencies));

		await this.getDependencies(files, dependencies);

		[ ...dependencies.keys() ].sort().forEach((dependency) => {
			if (base_dependencies[dependency]) {
				raw_dependencies[dependency] = base_dependencies[dependency];
				return;
			}

			if (!this.flags.tsconfig) {
				this.safeError(`Cannot resolve local dependency "${dependency}" without a tsconfig.json`);
				return;
			}

			if (local_dependencies[dependency]) {
				raw_dependencies[dependency] = local_dependencies[dependency];
				return;
			}

			this.warn(`Could not find dependency "${dependency}" in the base package.json or the local dependencies`);
		});

		this.log("Writing dependencies to package.json");
		await writeFile(
			this.flags.target,
			JSON.stringify({
				...this.target_package_json,
				dependencies: raw_dependencies,
			}, null, 4),
		);
	}

	/**
	 * Load the local dependencies from the tsconfig.json
	 * @returns {Promise<Record<string, string>>} The local dependencies
	 */
	async loadLocalDependencies() {
		this.log("Loading local dependencies");
		const deps: Record<string, string> = {};

		if (!this.flags.tsconfig) {
			this.warn("No tsconfig.json provided, skipping local dependencies");
			return deps;
		}

		const tsconfig_dir = this.flags.tsconfig.replace("tsconfig.json", "");
		const tsconfig = JSON.parse(await readFile(this.flags.tsconfig, "utf-8"));
		const paths = tsconfig?.compilerOptions?.paths || {};

		this.log(`Found ${Object.keys(paths).length} local dependencies, resolving versions`);

		await Promise.all(
			Object.keys(paths).map(async (path) => {
				const [ resolution_path ] = paths[path];

				const pjson = JSON.parse(
					await readFile(
						resolve(
							tsconfig_dir,
							resolution_path.replace("/src", ""),
							"package.json",
						),
						"utf-8",
					),
				);

				deps[path] = `^${pjson.version}` || "*";
			}),
		);

		return deps;
	}

	/**
	 * Load the dependencies from the package.json
	 * @param {string} path The path to the package.json
	 * @returns {Promise<Record<string, string>>} The dependencies object
	 */
	async loadDependencies(path: string) {
		this.log(`Loading dependencies from ${path}`);

		const package_json = JSON.parse(await readFile(path, "utf-8"));

		if (path === this.flags.target) {
			this.target_package_json = package_json;
		}

		return package_json.dependencies as Record<string, string> || {};
	}

	/**
	 * Get all the files in a folder that are not tests or typings
	 * @param {string} path The path to the folder
	 * @returns {Promise<Dirent[]>} The files
	 */
	async getFiles(path: string) {
		const files = await readdir(path, {
			recursive:     true,
			encoding:      "utf-8",
			withFileTypes: true,
		});

		// Filter out all the files that are not typescript/javascript files, tests or typings
		return files.filter((file) =>
			file.isFile() &&
			/\.[jt]sx?$/.test(file.name) &&
			!file.name.endsWith(".d.ts") &&
			!/(spec|test)\.[jt]sx?$/.test(file.name),
		);
	}

	/**
	 * Get all the non-local dependencies from the files and add them to the dependencies set
	 * @param {Dirent[]} files The files to check
	 * @param {Set<string>} dependencies The dependencies set to add the dependencies to
	 * @returns {Promise<void>} Resolves when done
	 */
	async getDependencies(files: Dirent[], dependencies: Set<string>) {
		this.log(`Checking ${files.length} files for dependencies`);

		// matches any non-relative import (starting with a dot)
		const import_regex = /^import.+from\s+["']([^.].+)["']/gm;
		let has_typescript_files = false;

		await Promise.all(files.map(async (file) => {
			this.logDebug(`Checking ${file.name}`);
			// Check if there are typescript files, if so we need to add tslib
			if (!has_typescript_files && (file.name.endsWith(".ts") || file.name.endsWith(".tsx"))) {
				has_typescript_files = true;
			}

			const content = await readFile(resolve(file.path, file.name), "utf-8");
			const matches = content.match(import_regex);

			if (!matches) {
				return;
			}

			for (const match of matches) {
				const dependency = match.replace(import_regex, "$1");
				this.logDebug(`Found dependency ${dependency} in ${file.name}`);

				// Ignore node dependencies (starting with node:)
				if (!dependency.startsWith("node:")) {
					dependencies.add(dependency);
				}
			}
		}));

		// Add tslib if there are typescript files
		if (has_typescript_files) {
			this.logDebug("Found typescript files, adding tslib");
			dependencies.add("tslib");
		}
	}
}
