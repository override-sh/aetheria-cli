import { DefaultLogFields, ListLogLine, LogResult } from "simple-git";
import { GreatestRelease } from "./greatest-release";

export interface PublishIsolatedModeConfigOverride {
	target: string
	soft_error: boolean,
	build: boolean,
	latest_commit: DefaultLogFields & ListLogLine,
	greatest_release: GreatestRelease,
	commit_history: LogResult,
	omit_continue_question: boolean,
}
