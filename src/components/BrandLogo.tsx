"use client";

import { useState } from "react";
import {
  faviconUrlFromDomain,
  hostnameFromUrl,
  logoUrlFromDomain,
  guessDomainFromName,
} from "@/lib/brand-logo";

export function BrandLogo({
  name,
  domain,
  website,
  logoUrl,
  size = 28,
  className = "",
}: {
  name: string;
  domain?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const host =
    domain ||
    hostnameFromUrl(website) ||
    hostnameFromUrl(logoUrl || undefined) ||
    guessDomainFromName(name);

  const primary = logoUrl || logoUrlFromDomain(host, size * 2);
  const fallback = faviconUrlFromDomain(host, size * 2);
  const [src, setSrc] = useState(primary);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-md bg-zinc-800 text-[10px] font-semibold uppercase text-zinc-300 ${className}`}
        style={{ width: size, height: size }}
        title={name}
      >
        {name.slice(0, 2)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 rounded-md bg-white object-contain ${className}`}
      style={{ width: size, height: size }}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        if (src !== fallback) setSrc(fallback);
        else setFailed(true);
      }}
    />
  );
}
