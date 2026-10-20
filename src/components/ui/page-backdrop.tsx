// What sits behind every signed-in screen: a faint grid of dots that fades out down the page, and a wide soft glow of the
// accent at the top. Both come from the theme's own tokens, so they follow light, dark and any future palette, and both are
// drawn behind the content and ignore the pointer. It is a server component: there is nothing to run.

export function PageBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0 opacity-70 [background-image:radial-gradient(var(--line)_1px,transparent_1px)] [background-size:26px_26px] [mask-image:radial-gradient(ellipse_75%_60%_at_50%_0%,#000_20%,transparent_75%)]"
      />
      <div
        className="absolute left-1/2 top-[-260px] h-[520px] w-[900px] -translate-x-1/2 rounded-full blur-3xl"
        style={{ background: "color-mix(in oklab, var(--accent) 13%, transparent)" }}
      />
    </div>
  )
}
