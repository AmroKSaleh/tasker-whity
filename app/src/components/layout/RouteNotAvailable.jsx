/**
 * Shared placeholder for routes whose backend hasn't been ported yet
 * (Plan A slice one). The page components themselves and their imports in
 * App.jsx are left in place — only reachability is removed — so restoring
 * a route in a later plan is a one-line change back to the real element.
 */
export default function RouteNotAvailable() {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Not available in this build</h1>
      <p>This feature&rsquo;s backend hasn&rsquo;t been ported to the whity-core host yet.</p>
    </div>
  )
}
