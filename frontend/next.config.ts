import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 writes frontend/AGENTS.md and frontend/CLAUDE.md on every build.
  // This repo's agent instructions live in the root CLAUDE.md; a second,
  // auto-generated copy one directory down is noise that drifts out of sync.
  agentRules: false,

  // @wf/shared and @wf/storage are published as TypeScript source, so Next must
  // compile them rather than treat them as prebuilt dependencies.
  transpilePackages: ["@wf/shared", "@wf/storage"],
};

export default nextConfig;
