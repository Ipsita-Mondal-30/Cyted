"use client";

import { useState } from "react";
import {
  domainFromLogoUrl,
  guessDomainFromName,
  logoUrlFromDomain,
  normalizeDomain,
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
    normalizeDomain(domain) ||
    normalizeDomain(website) ||
    domainFromLogoUrl(logoUrl) ||
    guessDomainFromName(name);

  const src = logoUrlFromDomain(host, Math.min(256, size * 2), name);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (failedSrc === src) {
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
      key={src}
      src={src}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 rounded-md bg-white object-contain ${className}`}
      style={{ width: size, height: size }}
      loading="lazy"
      title={name}
      onError={() => setFailedSrc(src)}
    />
  );
}
