import { Flags } from "@oclif/core";
import { spawn } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { inc } from "semver";
import simpleGit, { DefaultLogFields, ListLogLine, LogResult } from "simple-git";
import { BaseCommand } from "../../base";
import { parallelize } from "../../helpers";
import { AetheriaPjson, BumpVersion } from "../../interfaces";

export class Publish extends BaseCommand<typeof Publish> {
	static summary = "Build and publish a package";

	static examples = [ "<%= config.bin %> <%= command.id %>" ];

	static flags = {
		...BaseCommand.flags,
		target:       Flags.string({
			char:        "t",
			description: "The target package.json to build and publish",
			required:    true,
		}),
		build:        Flags.boolean({
			description: "Whether to build the package before publishing",
			default:     true,
			allowNo:     true,
		}),
		tag:          Flags.string({
			char:        "T",
			description: "The tag to use for the package",
			default:     "latest",
			required:    true,
		}),
		tsconfig:     Flags.string({
			description: "The tsconfig.json loaded by tsc in the build step, if not provided, the default tsconfig.json will be used",
		}),
		continue:     Flags.boolean({
			char:        "c",
			description: "Whether to continue the publish process even if the package have no changes since the last publish",
		}),
		publish:      Flags.boolean({
			description: "Whether to publish the package after building",
			default:     true,
			allowNo:     true,
		}),
		version_bump: Flags.boolean({
			description: "Whether to bump the version of the package before publishing",
			default:     true,
			allowNo:     true,
		}),
	};

	protected origin_folder!: string;

	public async run(): Promise<any> {
		this.origin_folder = dirname(this.flags.target);
		const pjson = JSON.parse(await readFile(this.flags.target, "utf-8")) as Record<string, any>;
		const config: AetheriaPjson = pjson.aetheria as AetheriaPjson || {
			assets: [],
		} as AetheriaPjson;

		this.verifyPreconditions(pjson);

		let build: Promise<void> | undefined;
		if (this.flags.build) {
			build = this.build();
		}

		const latest_commit = await this.getLatestCommitOrFail();

		if (!config.reference_commit) {
			this.warn("No reference commit found in aetheria configuration, using latest commit");
			config.reference_commit = latest_commit.hash;
		}

		this.log(`Found reference commit ${config.reference_commit}`);

		const commit_history = await this.getCommitHistory(config.reference_commit);
		this.log(`Found ${commit_history.total} commits since reference commit`);

		await this.ensureEnoughCommitsOrContinue(commit_history);
		this.bumpVersion(pjson, this.analyzeCommitHistory(commit_history));

		if (build) {
			await build;
		}

		// Run non dependent tasks in parallel
		const [ , dist_folder ] = await parallelize(
			this.updatePackageJSON(pjson, config),
			this.resolveDistFolder(),
		);

		await this.copyAssets(config, dist_folder);
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
	 * @param {Record<string, any>} pjson The package.json data
	 * @param {AetheriaPjson} config The aetheria configuration
	 * @returns {Promise<void>} A promise that resolves when the package.json is updated
	 * @private
	 */
	private async updatePackageJSON(pjson: Record<string, any>, config: AetheriaPjson) {
		const new_pjson: Record<string, any> = {
			...pjson,
			aetheria: config,
		};

		await writeFile(this.flags.target, JSON.stringify(new_pjson, null, 4));
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
	 * @returns {Promise<void>} A promise that resolves when the assets are copied
	 * @private
	 */
	private async copyAssets(config: AetheriaPjson, dist_folder: string) {
		this.log("Copying assets to dist folder ...");

		const assets = [
			...config.assets,
			"package.json",
		];

		await Promise.all(assets.map(async (asset) => {
			const destination = resolve(dist_folder, asset);
			const origin = resolve(this.origin_folder, asset);

			this.logDebug(`Copying asset '${origin}' to '${destination}' ...`);
			await cp(origin, destination, { recursive: true });
		}));

		this.log("Assets copied successfully");
	}

	/**
	 * Resolve the dist folder from the tsconfig.json
	 * @returns {Promise<string>} A promise that resolves with the dist folder
	 * @private
	 */
	private async resolveDistFolder() {
		const tsconfig_path = resolve(
			...(this.flags.tsconfig
				? [ this.flags.tsconfig ]
				: [
					this.origin_folder,
					"./tsconfig.json",
				]),
		);

		const tsconfig = JSON.parse(await readFile(tsconfig_path, "utf-8")) as Record<string, any>;
		return resolve(dirname(tsconfig_path), tsconfig?.compilerOptions?.outDir || "dist");
	}

	/**
	 * Bump the version in the package.json according to the commit analysis
	 * @param {Record<string, any>} pjson The package.json data
	 * @param {BumpVersion} commit_analysis The commit analysis
	 * @returns {void} Nothing
	 * @private
	 */
	private bumpVersion(pjson: Record<string, any>, commit_analysis: BumpVersion) {
		if (!this.flags.version_bump) {
			this.warn(`No version bump, current version is v${pjson.version}`);
			return;
		}

		if (!this.flags.publish) {
			this.warn("Skipping version bump");
			return;
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
	}

	/**
	 * Build the project using tsc
	 * @returns {Promise<void>} A promise that resolves when the project is built
	 * @private
	 */
	private build() {
		return new Promise<void>((ok, fail) => {
			this.log(`Building ${this.origin_folder} ...`);

			const child = spawn("tsc", { cwd: this.origin_folder });

			child.stderr.on("data", (data) => {
				this.warn(data.toString());
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
					fail();
				}
			});
		});
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
	 * @returns {void} Nothing
	 * @private
	 */
	private verifyPreconditions(pjson: Record<string, any>): void {
		if (!pjson.name) {
			this.error("No name specified in package.json");
		}

		if (!pjson.version) {
			this.error("No version specified in package.json");
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
