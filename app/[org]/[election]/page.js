import VoterApp from "../../../components/VoterApp";

/** Canonical voter route: /<org-slug>/<election-slug> */
export default async function ElectionVoterPage({ params }) {
  const { org, election } = await params;
  return <VoterApp orgSlug={org} electionSlug={election} />;
}
