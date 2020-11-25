import { createContext, Fragment, Suspense, useContext } from "react";
import { useLocation } from "react-router";
import { useQuery } from "react-query";
import Accordion from "@material-ui/core/Accordion";
import AccordionDetails from "@material-ui/core/AccordionDetails";
import AccordionSummary from "@material-ui/core/AccordionSummary";
import Link from "@material-ui/core/Link";
import ErrorBoundary from "../components/ErrorBoundary";
import Heading from "../components/Heading";

interface ProfilerReport {
	phase: "mount" | "update";
	actualDuration: number;
	baseDuration: number;
	startTime: number;
	commitTime: number;
	interactions: { id: number; name: string }[];
}

interface TestProfile {
	browserName: string;
	profile: Record<string, ProfilerReport[]>;
}
type TestProfiles = TestProfile[];

function useTestProfileParams() {
	const { search } = useLocation();
	const params = new URLSearchParams(search);

	return {
		buildNumber: params.get("buildNumber"),
	};
}

const TestProfilesContext = createContext<TestProfiles>(null!);

interface TimingAnalysisProps {
	timings: number[];
	format: (n: number) => string;
}

function TimingAnalysis(props: TimingAnalysisProps) {
	const { format, timings } = props;
	const mean = timings.sort((a, b) => a - b)[timings.length >> 1];

	return (
		<Fragment>
			mean: <em>{format(mean)}</em>
		</Fragment>
	);
}

function formatMs(ms: number): string {
	return ms.toFixed(2) + "ms";
}

function ProfilerInteractions(props: {
	interactions: { id: number; name: string }[];
}) {
	const interactions = props.interactions.map((interaction) => {
		const traceByStackMatch = interaction.name.match(
			/^([^:]+):(\d+):\d+ \(([^)]+)\)$/
		);
		if (traceByStackMatch === null) {
			return <li key={interaction.id}>{interaction.name}</li>;
		}
		const [, filename, lineNumber, interactionName] = traceByStackMatch;
		return (
			// TOOD: get PR for the current build
			<li key={interaction.id}>
				<Link
					href={`https://github.com/eps1lon/material-ui/tree/test/benchmark/${filename}#L${lineNumber}`}
					rel="noreferrer noopener"
					target="_blank"
				>
					{interactionName}@L{lineNumber}
				</Link>
			</li>
		);
	});

	return <ul>{interactions}</ul>;
}

interface ProfileAnalysisDetailsProps {
	testId: string;
}

function ProfileAnalysisDetails(props: ProfileAnalysisDetailsProps) {
	const { testId } = props;
	const testProfiles = useContext(TestProfilesContext);

	const profilesByBrowserName: Record<
		string,
		Array<{
			phase: ProfilerReport["phase"];
			actualDuration: ProfilerReport["actualDuration"][];
			baseDuration: ProfilerReport["baseDuration"][];
			startTime: ProfilerReport["startTime"][];
			commitTime: ProfilerReport["commitTime"][];
			interactions: ProfilerReport["interactions"];
		}>
	> = {};
	testProfiles.forEach(({ browserName, profile }) => {
		const testProfiles = profile[testId];
		if (testProfiles?.length > 0) {
			// squash {a: T, b: U}[] to {a: T[], b: U[]}
			if (profilesByBrowserName[browserName] === undefined) {
				profilesByBrowserName[browserName] = testProfiles.map((testProfile) => {
					return {
						phase: testProfile.phase,
						actualDuration: [testProfile.actualDuration],
						baseDuration: [testProfile.baseDuration],
						startTime: [testProfile.startTime],
						commitTime: [testProfile.commitTime],
						interactions: testProfile.interactions,
					};
				});
			} else {
				testProfiles.forEach((testProfile, interactionIndex) => {
					const interaction =
						profilesByBrowserName[browserName][interactionIndex];
					interaction.actualDuration.push(testProfile.actualDuration);
					interaction.baseDuration.push(testProfile.baseDuration);
					interaction.startTime.push(testProfile.startTime);
					interaction.commitTime.push(testProfile.commitTime);
				});
			}
		}
	});

	return (
		<table>
			<thead>
				<tr>
					{Object.keys(profilesByBrowserName).map((browserName) => {
						return <th key={browserName}>{browserName}</th>;
					})}
				</tr>
			</thead>
			<tbody>
				<tr>
					{Object.keys(profilesByBrowserName).map((browserName) => {
						const renders = profilesByBrowserName[browserName];

						return (
							<td key={browserName}>
								<table>
									<thead>
										<tr>
											<th>phase</th>
											<th>actualDuration</th>
											<th>baseDuration</th>
											<th>interactions</th>
										</tr>
									</thead>
									<tbody>
										{renders.map((render, interactionIndex) => {
											return (
												<tr key={interactionIndex}>
													<td>{render.phase}</td>
													<td>
														<TimingAnalysis
															format={formatMs}
															timings={render.actualDuration}
														/>
													</td>
													<td>
														<TimingAnalysis
															format={formatMs}
															timings={render.baseDuration}
														/>
													</td>
													<td>
														<ProfilerInteractions
															interactions={render.interactions}
														/>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</td>
						);
					})}
				</tr>
			</tbody>
		</table>
	);
}

interface ProfileAnalysisProps {
	testId: string;
}
function ProfileAnalysis(props: ProfileAnalysisProps) {
	const { testId } = props;

	return (
		<Accordion component="li" TransitionProps={{ unmountOnExit: true }}>
			<AccordionSummary>{testId}</AccordionSummary>
			<AccordionDetails>
				<ProfileAnalysisDetails testId={testId} />
			</AccordionDetails>
		</Accordion>
	);
}

interface TestProfileArtifactsInfo {
	browserName: string;
	timestamp: number;
	url: string;
}

async function fetchCircleCIArtifactsInfos(
	buildNumber: number
): Promise<Array<{ pretty_path: string; url: string }>> {
	const apiEndpoint = "https://circleci.com/api/v1.1/";
	const endpoint = `project/github/mui-org/material-ui/${buildNumber}/artifacts`;
	const url = `${apiEndpoint}${endpoint}`;
	const response = await fetch(url);
	const artifactsInfo = await response.json();

	return artifactsInfo;
}

async function fetchTestProfileArtifactsInfos(
	queryKey: unknown,
	buildNumber: number
): Promise<TestProfileArtifactsInfo[]> {
	const infos = await fetchCircleCIArtifactsInfos(buildNumber);

	return infos
		.map((artifactInfo) => {
			const match = artifactInfo.pretty_path.match(
				/^react-profiler-report\/karma\/([^/]+)\/(\d+)\.json$/
			);
			if (match === null) {
				return null;
			}
			const [, browserName, timestampRaw] = match;
			const timestamp = parseInt(timestampRaw, 10);

			return {
				browserName,
				timestamp,
				url: artifactInfo.url,
			};
		})
		.filter(
			(
				maybeTestProfileArtifact
			): maybeTestProfileArtifact is TestProfileArtifactsInfo => {
				return maybeTestProfileArtifact !== null;
			}
		);
}

function useTestProfileArtifactsInfos(
	buildNumber: number
): TestProfileArtifactsInfo[] {
	const testProfileArtifactsInfosResponse = useQuery(
		["test-profile-artifacts", buildNumber],
		fetchTestProfileArtifactsInfos
	);

	return testProfileArtifactsInfosResponse.data!;
}

function fetchTestProfileArtifacts(
	queryKey: unknown,
	infos: TestProfileArtifactsInfo[]
): Promise<TestProfile[]> {
	return Promise.all(
		infos.map(async (info) => {
			const url = `/.netlify/functions/test-profile-artifact?url=${info.url}`;
			const response = await fetch(url);
			const testProfile: TestProfile["profile"] = await response.json();

			return {
				browserName: info.browserName,
				profile: testProfile,
			};
		})
	);
}

function useTestProfiles(buildNumber: number): TestProfiles {
	const infos = useTestProfileArtifactsInfos(buildNumber);
	const testProfileArtifactResponse = useQuery(
		["profile-reports", infos],
		fetchTestProfileArtifacts
	);
	return testProfileArtifactResponse.data!;
}

interface CircleCITestProfileAnalysisProps {
	buildNumber: string | null;
}

function CircleCITestProfileAnalysis(props: CircleCITestProfileAnalysisProps) {
	const buildNumber = parseInt(props.buildNumber!, 10);
	if (Number.isNaN(buildNumber)) {
		throw new Error(`Unable to convert '${props.buildNumber}' to a number`);
	}

	const testProfiles = useTestProfiles(buildNumber);
	const testIdsWithProfilingData = Array.from(
		new Set(
			testProfiles.reduce((testIdsDuplicated, { profile }) => {
				return testIdsDuplicated.concat(
					Object.keys(profile).filter((testId) => {
						return profile[testId].length > 0;
					})
				);
			}, [] as string[])
		)
	).sort((a, b) => {
		return a.localeCompare(b);
	});

	return (
		<TestProfilesContext.Provider value={testProfiles}>
			<ol>
				{testIdsWithProfilingData.map((testId) => {
					return <ProfileAnalysis key={testId} testId={testId} />;
				})}
			</ol>
		</TestProfilesContext.Provider>
	);
}

export default function TestProfileAnalysis() {
	const { buildNumber } = useTestProfileParams();

	return (
		<Fragment>
			<Heading level="1">Test profiling analysis</Heading>
			<Suspense
				fallback={
					<p>
						Loading comparison for build <em>{buildNumber}</em>
					</p>
				}
			>
				<ErrorBoundary
					fallback={
						<p>
							Unable to analyse test profile of build <em>{buildNumber}</em>
						</p>
					}
				>
					<CircleCITestProfileAnalysis buildNumber={buildNumber} />
				</ErrorBoundary>
			</Suspense>
		</Fragment>
	);
}
