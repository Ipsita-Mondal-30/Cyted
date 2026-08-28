"use client";

const ROWS = [
  [
    { name: "Adobe", domain: "adobe.com" },
    { name: "Nike", domain: "nike.com" },
    { name: "Slack", domain: "slack.com" },
    { name: "Netflix", domain: "netflix.com" },
    { name: "Airbnb", domain: "airbnb.com" },
    { name: "Spotify", domain: "spotify.com" },
    { name: "Uber", domain: "uber.com" },
    { name: "Notion", domain: "notion.so" },
  ],
  [
    { name: "Apple", domain: "apple.com" },
    { name: "Amazon", domain: "amazon.com" },
    { name: "Microsoft", domain: "microsoft.com" },
    { name: "Google", domain: "google.com" },
    { name: "Discord", domain: "discord.com" },
    { name: "Shopify", domain: "shopify.com" },
    { name: "Stripe", domain: "stripe.com" },
    { name: "Reddit", domain: "reddit.com" },
  ],
  [
    { name: "Coca-Cola", domain: "coca-cola.com" },
    { name: "LEGO", domain: "lego.com" },
    { name: "IKEA", domain: "ikea.com" },
    { name: "Walmart", domain: "walmart.com" },
    { name: "Nvidia", domain: "nvidia.com" },
    { name: "Twitch", domain: "twitch.tv" },
    { name: "Dropbox", domain: "dropbox.com" },
    { name: "Figma", domain: "figma.com" },
  ],
];

function LogoTile({ name, domain }: { name: string; domain: string }) {
  return (
    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900 shadow-[0_8px_30px_rgba(0,0,0,0.45)] sm:h-16 sm:w-16">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`https://logo.clearbit.com/${domain}?size=128`}
        alt={name}
        width={36}
        height={36}
        className="h-8 w-8 object-contain sm:h-9 sm:w-9"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => {
          const el = e.currentTarget;
          el.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
        }}
      />
    </div>
  );
}

function MarqueeRow({
  brands,
  reverse,
  duration,
}: {
  brands: Array<{ name: string; domain: string }>;
  reverse?: boolean;
  duration: string;
}) {
  const loop = [...brands, ...brands, ...brands];
  return (
    <div className="overflow-hidden">
      <div
        className={`flex w-max gap-3 ${reverse ? "animate-marquee-reverse" : "animate-marquee"}`}
        style={{ animationDuration: duration }}
      >
        {loop.map((b, i) => (
          <LogoTile key={`${b.domain}-${i}`} name={b.name} domain={b.domain} />
        ))}
      </div>
    </div>
  );
}

export function BrandLogoCarousel() {
  return (
    <div className="relative mx-auto mt-10 w-full max-w-4xl overflow-hidden px-0">
      <div
        className="overflow-hidden py-10 sm:py-12"
        style={{
          perspective: "900px",
          maskImage:
            "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
        }}
      >
        <div
          className="origin-center space-y-3 opacity-90"
          style={{
            transform: "rotateX(38deg) rotateZ(-6deg) scale(0.88)",
            transformStyle: "preserve-3d",
          }}
        >
          <MarqueeRow brands={ROWS[0]} duration="38s" />
          <MarqueeRow brands={ROWS[1]} reverse duration="44s" />
          <MarqueeRow brands={ROWS[2]} duration="40s" />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black to-transparent" />
    </div>
  );
}
