import { Flags } from "@oclif/core";
import { spawn } from "node:child_process";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gt, inc } from "semver";
import simpleGit, { DefaultLogFields, ListLogLine, LogResult } from "simple-git";
import { BaseCommand } from "../../base";
import { parallelize } from "../../helpers";
import { AetheriaPjson, BumpVersion, GreatestRelease, PublishIsolatedModeConfigOverride } from "../../interfaces";

export class Publish extends BaseCommand<typeof Publish> {
	static summary = "Build and publish a package";

	static description = `
		Build and publish a package.
		When using the --isolated flag, acts on as package scoped.
		When using the --nx-target flag, acts in frontend mode.
		
		Backend mode:
		- The --nx-target flag should not be used
		- The --tsconfig flag is required
		- The --isolated flag is optional
		- The --tsconfig flag must be a valid tsconfig.json file
		
		Frontend mode:
		- The --nx-target flag is required
		- The --tsconfig flag is required
		- The --isolated flag is optional
		- The --nx-target flag must be a valid nx target (e.g. plugin-example-frontend) or -
		- The --tsconfig flag must be a valid tsconfig.json file
		
		if the --nx-target flag is -, the target name will be inferred from the project.json file of a nx project
		
	`;

	static examples = [
		{
			command:     "<%= config.bin %> <%= command.id %> -t ../headless/libs/config/package.json --tsconfig tsconfig.lib.json --isolated",
			description: "Build and publish the @aetheria/config package (in isolated mode)",
		},
		{
			command:     "<%= config.bin %> <%= command.id %> -t ../headless/libs/ --tsconfig tsconfig.lib.json",
			description: "Build and publish the @aetheria/* packages (in monorepo mode)",
		},
		{
			command:     "<%= config.bin %> <%= command.id %> -t ../frontend/libs/ --tsconfig tsconfig.lib.json --isolated --nx-target plugin-example-frontend",
			description: "Build and publish the @aetheria/plugin-example-frontend package (in frontend-isolated mode)",
		},
		{
			command:     "<%= config.bin %> <%= command.id %> -t ../frontend/libs/ --tsconfig tsconfig.lib.json --nx-target -",
			description: "Build and publish the @aetheria/* packages (in frontend-monorepo mode)",
		},
	];

	static flags = {
		...BaseCommand.flags,
		target:       Flags.string({
			char:        "t",
			description: "The target directory containing libraries or a package.json to build and publish",
			required:    true,
		}),
		build:        Flags.boolean({
			description: "Whether to build the package(s) before publishing",
			default:     true,
			allowNo:     true,
		}),
		tag:          Flags.string({
			char:        "T",
			description: "The tag to use for the package(s)",
			default:     "latest",
			required:    true,
		}),
		tsconfig:     Flags.string({
			description: "The name of the tsconfig.json loaded by tsc in the build step(s), if not provided, the default tsconfig.json will be used",
		}),
		continue:     Flags.boolean({
			char:        "c",
			description: "Whether to continue the publish process even if the package(s) have no changes since the last publish",
		}),
		publish:      Flags.boolean({
			description: "Whether to publish the package(s) after building",
			default:     true,
			allowNo:     true,
		}),
		version_bump: Flags.boolean({
			description: "Whether to bump the version of the package(s) before publishing",
			default:     true,
			allowNo:     true,
		}),
		isolated:     Flags.boolean({
			description: "Whether to publish the package in isolated mode (no monorepo, publish only the package)",
		}),
		"nx-target":  Flags.string({
			description: "The target to use for the nx command (only used in frontend)",
		}),
	};

	protected origin_folder!: string;

	public async run(): Promise<any> {
		// if the target is a package.json, we need to get the folder containing it
		this.origin_folder = /\.[^/]+$/g.test(this.flags.target) ? dirname(this.flags.target) : this.flags.target;

		await (this.flags.isolated ? this.runIsolated() : this.runMonorepo());
	}

	/**
	 * Run the publish command in monorepo mode (publish all libraries in the given folder)
	 * @returns {Promise<void>} A promise that resolves when the publish process is complete
	 * @private
	 */
	private async runMonorepo(): Promise<void> {
		this.log(`Running in monorepo mode, all libraries in '${this.origin_folder}' will be updated and published`);

		// get all entities in the target folder (the origin folder) and ensure they are all folders (aka libraries)
		const libs = await readdir(
			this.origin_folder,
			{
				withFileTypes: true,
				encoding:      "utf-8",
			},
		);
		const lib_folders = libs.filter((lib) => lib.isDirectory()).map((lib) => lib.name);

		this.log(`Found ${lib_folders.length} libraries in '${this.origin_folder}'`);
		lib_folders.forEach((lib) => {
			this.logDebug(`Found library folder '${lib}'`);
		});

		if (!this.flags.build) {
			this.warn(`Running in monorepo mode without building the libraries first is not allowed, libraries will be built before publishing`);
		}

		// run common operations for all libraries in parallel
		const [ latest_commit, greatest_release ] = await parallelize(
			this.getLatestCommitOrFail(),
			this.findGreatestRelease(lib_folders),
		);

		await this.build(lib_folders);
		const commit_history = await this.getCommitHistory(greatest_release.reference_commit.commit);

		// ensure there are enough commits to publish
		await this.ensureEnoughCommitsOrContinue(commit_history);

		await this.log(`Delegating the publish process to (prepared) isolated mode`);
		// run the publish process for each library in parallel
		await parallelize(
			...lib_folders.map(async (lib) => {
				return this.runIsolated({
					target:                 resolve(this.origin_folder, lib, "package.json"),
					soft_error:             true,
					build:                  false,
					omit_continue_question: true,
					latest_commit,
					greatest_release,
					commit_history,
				});
			}),
		);
	}

	/**
	 * Find the greatest release between all the libraries in the given folder
	 * @param {string[]} lib_folders The list of libraries to check
	 * @returns {Promise<GreatestRelease>} A promise that resolves with the greatest release found
	 * @private
	 */
	private async findGreatestRelease(lib_folders: string[]): Promise<GreatestRelease> {
		this.logDebug(`Finding the greatest release between all libraries in '${this.origin_folder}'`);

		// get the package.json of each library
		const pjsons = await parallelize(
			...lib_folders.map(async (lib) => {
				const pjson = JSON.parse(await readFile(
					resolve(this.origin_folder, lib, "package.json"),
					"utf-8",
				)) as Record<string, any>;

				return pjson;
			}),
		);

		// get the version and reference commit of each library
		const versions: string[] = pjsons.map((pjson) => pjson?.version ?? "0.0.0");
		versions.forEach((version, index) => {
			this.logDebug(`Found library '${lib_folders[index]}' with version '${version}'`);
		});

		const reference_commit: string[] = pjsons.map((pjson) => pjson?.aetheria?.reference_commit ?? "HEAD");
		reference_commit.forEach((commit, index) => {
			this.logDebug(`Found library '${lib_folders[index]}' with reference commit '${commit}'`);
		});

		// get the commit history of each library and find the number of commits and reference commit
		const commits = await parallelize(
			...reference_commit.map(async (commit) => {
				const git = simpleGit({
					baseDir: this.origin_folder,
				});

				const log = await git.log({
					from: commit,
					to:   "HEAD",
				});

				return {
					total: log.total,
					commit,
				};
			}),
		);

		return {
			// find the greatest version
			greatest_version: versions.reduce(
				(greatest, current) => gt(greatest, current) ? greatest : current,
				"0.0.0",
			),
			// find the greatest number of commits (longest unpublished history) and its reference commit
			reference_commit: commits.reduce(
				(greatest, current) => current.total > greatest.total ? current : greatest,
				{
					total:  0,
					commit: "HEAD",
				},
			),
		};
	}

	/**
	 * Run the publish command in isolated mode (publish only the package in the given folder)
	 * @param {PublishIsolatedModeConfigOverride} override The override configuration for the isolated mode
	 * @returns {Promise<void>} A promise that resolves when the publish process is complete
	 * @private
	 */
	private async runIsolated(override?: PublishIsolatedModeConfigOverride): Promise<void> {
		const target = override?.target ?? this.flags.target;

		this.log(`Running in isolated mode, publishing '${target}'`);

		// get the package.json of the target package and ensure it has the aetheria property (aka it's a valid package)
		const pjson = JSON.parse(await readFile(target, "utf-8")) as Record<string, any>;
		const config: AetheriaPjson = pjson.aetheria as AetheriaPjson || {
			assets: [],
		} as AetheriaPjson;

		// verify the preconditions for the publish process
		this.verifyPreconditions(pjson, override?.soft_error);

		// run the build process if needed
		let build: Promise<void> | undefined;
		if (override?.build ?? this.flags.build) {
			build = this.build([ dirname(target).split("/").at(-1) || "" ]);
		}

		// get the latest commit and define the reference commit if not already defined
		const latest_commit = override?.latest_commit ?? await this.getLatestCommitOrFail();
		config.reference_commit = override?.greatest_release?.reference_commit.commit ?? config.reference_commit ??
		                          latest_commit.hash;

		this.log(`Found reference commit ${config.reference_commit}`);

		// get the commit history since the reference commit
		const commit_history = override?.commit_history ??
		                       await this.getCommitHistory(config.reference_commit as string);
		this.log(`Found ${commit_history.total} commits since reference commit`);

		// ensure there are enough commits to publish
		if (!override?.omit_continue_question) {
			await this.ensureEnoughCommitsOrContinue(commit_history);
		}

		pjson.version = override?.greatest_release?.greatest_version ?? pjson.version;
		config.reference_commit = latest_commit.hash;

		// bump the version and update the package.json
		this.bumpVersion(pjson, this.analyzeCommitHistory(commit_history));

		// await the build process if previously started
		if (build) {
			await build;
		}

		// Run non dependent tasks in parallel
		const [ , dist_folder ] = await parallelize(
			this.updatePackageJSON(target, pjson, config),
			this.resolveDistFolder(dirname(target)),
		);

		// copy the assets only if not running in nx mode, nx will handle the assets itself
		if (!this.flags["nx-target"]) {
			await this.copyAssets(config, dist_folder, dirname(target));
		}

		// complete the publish process
		await this.publish(pjson, dist_folder);
	}

	private async ensureEnoughCommitsOrContinue(commit_history: LogResult): Promise<void> {
		if (commit_history.total === 0 && !this.flags.continue) {
			// eslint-disable-next-line unicorn/prefer-module
			const inquirer = require("inquirer");

			const response: { continue: boolean } = await inquirer.prompt({
				type:    "confirm",
				name:    "continue",
				message: "No commits found since reference commit, continue publishing?",
				default: false,
			});

			if (!response.continue) {
				this.warn("Publishing cancelled");
				this.exit(1);
			}
		}
	}

	/**
	 * Update the package.json data with the new version and the new reference commit
	 * @param target The target package.json path
	 * @param {Record<string, any>} pjson The package.json data
	 * @param {AetheriaPjson} config The aetheria configuration
	 * @returns {Promise<void>} A promise that resolves when the package.json is updated
	 * @private
	 */
	private async updatePackageJSON(target: string, pjson: Record<string, any>, config: AetheriaPjson) {
		const new_pjson: Record<string, any> = {
			...pjson,
			aetheria: config,
		};

		await writeFile(target, JSON.stringify(new_pjson, null, 4));
	}

	/**
	 * Publish the package to npm
	 * @param pjson The package.json data
	 * @param {string} dist_folder The dist folder
	 * @returns {Promise<void>} A promise that resolves when the package is published
	 * @private
	 */
	private publish(pjson: Record<string, any>, dist_folder: string) {
		if (!this.flags.publish) {
			this.warn("Skipping publishing");
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			this.log(`Publishing ${pjson.name}@${pjson.version} and ${pjson.name}@${this.flags.tag} ...`);

			const publish = spawn(
				"npm",
				[
					"publish",
					"--tag",
					this.flags.tag,
				],
				{
					cwd: dist_folder,
				},
			);

			publish.stdout.on("data", (data) => {
				console.log(data.toString());
			});

			publish.stderr.on("data", (data) => {
				console.log(data.toString());
			});

			publish.on("error", (error) => {
				this.error(error);
			});

			publish.on("close", (code) => {
				if (code === 0) {
					this.log("Package published successfully");
					resolve();
				}
				else {
					reject();
				}
			});
		});
	}

	/**
	 * Copy the defined assets to the dist folder, always copy the package.json
	 * @param {AetheriaPjson} config The aetheria configuration
	 * @param {string} dist_folder The dist folder
	 * @param origin_folder The origin folder
	 * @returns {Promise<void>} A promise that resolves when the assets are copied
	 * @private
	 */
	private async copyAssets(config: AetheriaPjson, dist_folder: string, origin_folder: string) {
		this.log("Copying assets to dist folder ...");

		const assets = [
			...config.assets,
			"package.json",
		];

		await parallelize(...assets.map(async (asset) => {
			const destination = resolve(dist_folder, asset);
			const origin = resolve(origin_folder, asset);

			this.logDebug(`Copying asset '${origin}' to '${destination}' ...`);
			await cp(origin, destination, { recursive: true });
		}));

		this.log("Assets copied successfully");
	}

	/**
	 * Resolve the dist folder from the tsconfig.json
	 * @param {string} base_folder The base folder
	 * @returns {Promise<string>} A promise that resolves with the dist folder
	 * @private
	 */
	private async resolveDistFolder(base_folder: string) {
		const tsconfig_path = resolve(
			base_folder,
			this.flags.tsconfig
				? this.flags.tsconfig
				: "tsconfig.json",
		);

		const tsconfig = JSON.parse(await readFile(tsconfig_path, "utf-8")) as Record<string, any>;
		return resolve(
			base_folder,
			(!this.flags["nx-target"] ? tsconfig?.compilerOptions?.outDir : tsconfig?.compilerOptions?.outDir.replace(
				"out-tsc",
				"libs/" + JSON.parse(await readFile(resolve(base_folder, "project.json"), "utf-8")).name,
			)) || "dist",
		);
	}

	/**
	 * Bump the version in the package.json according to the commit analysis
	 * @param {Record<string, any>} pjson The package.json data
	 * @param {BumpVersion} commit_analysis The commit analysis
	 * @returns {void} Nothing
	 * @private
	 */
	private bumpVersion(pjson: Record<string, any>, commit_analysis: BumpVersion) {
		if (this.flags.isolated) {
			if (!this.flags.version_bump) {
				this.warn(`No version bump, current version is v${pjson.version}`);
				return;
			}

			if (!this.flags.publish) {
				this.warn("Skipping version bump");
				return;
			}
		}
		else if (!this.flags.isolated && !this.flags.version_bump) {
			this.warn(`Version bump cannot be disabled in monorepo mode, bumping versions`);
		}

		if (commit_analysis.major) {
			this.log("Bumping major version");
			pjson.version = inc(pjson.version, "major");
		}
		else if (commit_analysis.minor) {
			this.log("Bumping minor version");
			pjson.version = inc(pjson.version, "minor");
		}
		else if (commit_analysis.patch) {
			this.log("Bumping patch version");
			pjson.version = inc(pjson.version, "patch");
		}
		else {
			this.log(`No changes found, current version is ${pjson.version}`);
		}

		this.log(`New version is ${pjson.version}`);
	}

	/**
	 * Infer the nx target from the project.json file
	 * @param {string[]} lib_folders The lib folders
	 * @returns {Promise<[string, string, string][]>} A promise that resolves with the nx targets in the format [nx,
	 *     run, target-build-command]
	 * @private
	 */
	private async inferNxTarget(lib_folders: string[]) {
		this.log("Inferring nx target ...");

		const nx_targets = (await parallelize(...lib_folders.map(async (lib_folder): Promise<string | null> => {
			const project_json = JSON.parse(await readFile(
				resolve(this.origin_folder, lib_folder, "project.json"),
				"utf-8",
			)) as Record<string, any>;

			if (project_json.name) {
				return project_json.name;
			}

			return null;
		}))).filter((value) => value !== null) as string[];

		return nx_targets.map((nx_target) => {
			return [
				"nx",
				"run",
				`${nx_target}:build:production`,
				"--verbose",
				"--output-style",
				"stream",
			];
		});
	}

	/**
	 * Generate the commands to execute when running in nx monorepo mode
	 * @param {string[]} lib_folders The lib folders
	 * @returns {Promise<[string, string, string][] | string[][]>} A promise that resolves with the commands to execute
	 * @private
	 */
	private async nxCommandGenerator(lib_folders: string[]) {
		if (this.flags["nx-target"] !== "-") {
			return [
				[
					"nx",
					"run",
					`${this.flags["nx-target"]}:build`,
					"--verbose",
					"--output-style",
					"stream",
				],
			];
		}

		return this.inferNxTarget(lib_folders as string[]);
	}

	/**
	 * Build a single project
	 * @param {[string, string[]]} command The command to execute
	 * @returns {void} Nothing
	 * @private
	 */
	private plainBuild(
		command: [ string, string[] ],
	) {
		return new Promise<void>((ok, fail) => {
			this.logDebug(`Running '${command[0]} ${command[1].join(" ")}' ...`);
			const child = spawn(command[0], command[1], { cwd: this.origin_folder });

			child.stdout.on("data", (data) => {
				if (this.flags.debug) {
					console.log(data.toString());
				}
			});

			child.stderr.on("data", (data) => {
				if (this.flags.debug) {
					console.log(data.toString());
				}
			});

			child.on("error", (err) => {
				this.safeError(err);
			});

			child.on("close", (code) => {
				if (code === 0) {
					this.log("Build successfully");
					ok();
				}
				else {
					this.safeError(`Build failed with code ${code}`);
					fail(new Error(`Build failed with code ${code}`));
				}
			});
		});
	}

	/**
	 * Build the project using tsc
	 * @returns {Promise<void>} A promise that resolves when the project is built
	 * @private
	 * @param lib_folders  The lib folders
	 */
	private async build(lib_folders?: string[]) {
		this.log(`Building ${this.origin_folder} ...`);

		if (this.flags["nx-target"]) {
			const commands = await this.nxCommandGenerator(lib_folders as string[]);

			for (const command of commands) {
				// eslint-disable-next-line no-await-in-loop
				await this.plainBuild(
					[
						"npx",
						command,
					],
				);
			}
		}
		else {
			await this.plainBuild(
				[
					"tsc",
					[],
				],
			);
		}
	}

	/**
	 * Analyze the commit history to determine the version bump type (major, minor, patch) based on the commit messages
	 * @param {LogResult<DefaultLogFields>} commit_history The commit history
	 * @returns {BumpVersion} The bump version
	 * @private
	 */
	private analyzeCommitHistory(commit_history: LogResult<DefaultLogFields>): BumpVersion {
		const major = commit_history.all.some(
			(commit) =>
				commit.message.includes("BREAKING CHANGE:") ||
				commit.body.includes("BREAKING CHANGE:"),
		);
		const minor = commit_history.all.some(
			(commit) =>
				commit.message.includes("feat:") ||
				commit.body.includes("feat:"),
		);
		const patch = commit_history.all.some(
			(commit) =>
				commit.message.includes("fix:") ||
				commit.body.includes("fix:"),
		);

		return {
			major,
			minor,
			patch,
		};
	}

	/**
	 * Verify that the preconditions are met
	 * @param {Record<string, any>} pjson The package.json data
	 * @param soft_error Whether to throw a soft error or not
	 * @returns {void} Nothing
	 * @private
	 */
	private verifyPreconditions(pjson: Record<string, any>, soft_error?: boolean): void {
		if (!pjson.name) {
			this[soft_error ? "safeError" : "error"]("No name specified in package.json");
		}

		if (!pjson.version) {
			this[soft_error ? "safeError" : "error"]("No version specified in package.json");
		}

		if (!pjson.aetheria) {
			this.warn("No aetheria configuration found in package.json, using default configuration");
		}
	}

	/**
	 * Get the commit history from the latest known commit to the latest commit
	 * @param {string} latest_commit The latest commit
	 * @returns {Promise<LogResult<DefaultLogFields>>} A promise that resolves with the commit history
	 * @private
	 */
	private getCommitHistory(latest_commit: string): Promise<LogResult<DefaultLogFields>> {
		return simpleGit(this.origin_folder).log({
			from: latest_commit,
		});
	}

	/**
	 * Get the latest commit from the origin folder
	 * @returns {Promise<(DefaultLogFields & ListLogLine) | null>} A promise that resolves with the latest commit or
	 *     null if no commits are found
	 * @private
	 */
	private async getLastCommit(): Promise<(DefaultLogFields & ListLogLine) | null> {
		return (await simpleGit(this.origin_folder).log({
			maxCount: 1,
		})).latest;
	}

	/**
	 * Get the latest commit from the origin folder or fail if no commits are found
	 * @returns {Promise<DefaultLogFields & ListLogLine>} A promise that resolves with the latest commit
	 * @private
	 */
	private async getLatestCommitOrFail(): Promise<DefaultLogFields & ListLogLine> {
		const latest_commit = await this.getLastCommit();

		if (!latest_commit) {
			this.error(`No commits found in ${this.origin_folder}`);
		}

		return latest_commit;
	}
}
