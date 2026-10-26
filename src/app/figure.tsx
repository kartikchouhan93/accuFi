// The one large figure a screen opens with (net worth, a portfolio's value), set so its type does the work: the rupee sign
// and the paise smaller and dimmer than the whole rupees between them, each settling into place a beat after the last
// (.settle, which the reduced-motion rule stills). The text is unbroken for anything that reads it; only the styling is split.

// "-₹1,09,749.75" as sign and symbol, whole rupees, paise. Anything that does not look like that is printed as it is.
export function Figure({ text }: { text: string }) {
  const match = /^(-?)(₹)([\d,]+)(\.\d{2})$/.exec(text)
  if (!match) return <>{text}</>
  const [, sign, symbol, whole, paise] = match
  return (
    <>
      <span className="settle mr-1 align-top text-[0.5em] leading-[1.6] text-fg-soft">
        {sign}
        {symbol}
      </span>
      <span className="settle" style={{ "--delay": "90ms" } as React.CSSProperties}>
        {whole}
      </span>
      <span className="settle text-[0.5em] text-fg-soft" style={{ "--delay": "220ms" } as React.CSSProperties}>
        {paise}
      </span>
    </>
  )
}
