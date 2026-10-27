import { redirect } from "next/navigation"

// The reports open on net worth. A range in the URL comes along, so a link to /reports?range=… still shows that range.
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, one)
  }
  const query = params.toString()
  redirect(`/reports/net-worth${query ? `?${query}` : ""}`)
}
