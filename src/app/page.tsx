import { redirect } from "next/navigation"

// Placeholder until the dashboard (Task 14) takes this route: signing in lands on "/", and the ledger is the only
// screen there is. The route guard already sends anyone without a session to /login before this runs.
export default function Home() {
  redirect("/nodes")
}
