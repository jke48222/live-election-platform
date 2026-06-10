import VoterApp from "../../../components/VoterApp";

/** Canonical voter route: /<org-slug>/<election-slug> */
export default function ElectionVoterPage({ params }) {
  return <VoterApp orgSlug={params.org} electionSlug={params.election} />;
}
