import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  GITHUB_TOKEN: string;
}

const OWNER = "eliranpublicis";
const REPO = "publisher-creatives";
const BRANCH = "main";
const PUBLIC_BASE = "https://publisher-creatives.eliran-publicis.workers.dev";

function jsonText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function safeSegment(value: string) {
  return value.trim().replace(/[\\/]/g, "-").replace(/\s+/g, " ").slice(0, 120);
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function extFromMime(mime: string, filename: string) {
  const lower = mime.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  const m = filename.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return m?.[1] || "bin";
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } {
  const lower = mime.toLowerCase();

  if ((lower.includes("png") || (bytes[0] === 0x89 && bytes[1] === 0x50)) && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (lower.includes("jpeg") || lower.includes("jpg") || (bytes[0] === 0xff && bytes[1] === 0xd8)) {
    let i = 2;
    const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    while (i + 8 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
      if (i + 4 >= bytes.length) break;
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (sof.has(marker) && i + 8 < bytes.length) {
        const height = (bytes[i + 5] << 8) | bytes[i + 6];
        const width = (bytes[i + 7] << 8) | bytes[i + 8];
        return { width, height };
      }
      if (len < 2) break;
      i += 2 + len;
    }
  }

  throw new Error("Unsupported image format or dimensions could not be read.");
}

async function gh(env: Env, path: string, init: RequestInit = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is missing.");
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "publisher-creatives-uploader",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json<any>();
}

async function createBlob(env: Env, content: string, encoding: "utf-8" | "base64") {
  const r = await gh(env, "/git/blobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, encoding }),
  });
  return r.sha as string;
}

function responsiveHtml(items: Array<{ src: string; width: number; height: number }>) {
  const data = JSON.stringify(items);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
body{display:flex;align-items:center;justify-content:center}
img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}
</style>
</head>
<body>
<img id="creative" alt="">
<script>
const creatives=${data};
function choose(){
  const ratio=innerWidth/innerHeight;
  const best=creatives.reduce((a,b)=>Math.abs((b.width/b.height)-ratio)<Math.abs((a.width/a.height)-ratio)?b:a);
  const img=document.getElementById("creative");
  if(img.getAttribute("src")!==best.src) img.setAttribute("src",best.src);
}
addEventListener("resize",choose,{passive:true});
choose();
</script>
</body>
</html>`;
}

function ynetTxt(creativeUrl: string, landingUrl: string) {
  const href = `%%CLICK_URL_UNESC%%${landingUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}`;
  const src = creativeUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<div style="position:relative;width:100%;height:100%;overflow:hidden;">
  <iframe src="${src}" width="100%" height="100%" scrolling="no" frameborder="0" style="position:absolute;inset:0;width:100%;height:100%;border:0;z-index:1;"></iframe>
  <a href="${href}" target="_blank" rel="noopener" aria-label="Advertisement" style="position:absolute;inset:0;display:block;z-index:2;"></a>
</div>`;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "Publisher HTML5 Agent Uploader",
    version: "0.2.0",
  });

  server.registerTool(
    "health_check",
    {
      description: "Verify that the Publisher HTML5 Agent MCP bridge is online and report whether publishing credentials are configured.",
      inputSchema: z.object({ message: z.string().optional() }),
    },
    async ({ message }) => jsonText({
      ok: true,
      service: "publisher-creatives-uploader",
      version: "0.2.0",
      githubConfigured: Boolean(env.GITHUB_TOKEN),
      message: message ?? "MCP bridge is online",
    }),
  );

  server.registerTool(
    "publish_creative",
    {
      description:
        "Publish uploaded JPG/PNG creative files as one responsive HTML5 interstitial. Pass a temporary download_url for each ChatGPT attachment. The tool commits all files and generated HTML/TXT to GitHub in one commit; Cloudflare then deploys the static assets automatically.",
      inputSchema: z.object({
        client: z.string().min(1),
        campaign: z.string().min(1),
        publisher: z.string().min(1),
        creative_name: z.string().min(1),
        landing_url: z.string().url(),
        creatives: z.array(z.object({
          filename: z.string().min(1),
          download_url: z.string().url(),
          mime_type: z.string().default("image/jpeg"),
        })).min(1).max(20),
      }),
    },
    async (input) => {
      const publisher = input.publisher.trim().toUpperCase();
      if (publisher !== "YNET") {
        return jsonText({ ok: false, error: "Only YNET is enabled in version 0.2.0." });
      }

      const baseParts = [
        safeSegment(input.client),
        safeSegment(input.campaign),
        publisher,
        safeSegment(input.creative_name),
      ];
      const relativeBase = baseParts.join("/");
      const repoBase = `public/${relativeBase}`;

      const downloaded: Array<{
        filename: string;
        mime: string;
        bytes: Uint8Array;
        width: number;
        height: number;
        assetName: string;
      }> = [];

      for (let i = 0; i < input.creatives.length; i++) {
        const c = input.creatives[i];
        const res = await fetch(c.download_url);
        if (!res.ok) throw new Error(`Could not download ${c.filename}: HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > 10 * 1024 * 1024) throw new Error(`${c.filename} exceeds 10 MB.`);
        const mime = (res.headers.get("content-type") || c.mime_type || "image/jpeg").split(";")[0];
        const { width, height } = imageDimensions(bytes, mime);
        const ext = extFromMime(mime, c.filename);
        downloaded.push({
          filename: c.filename,
          mime,
          bytes,
          width,
          height,
          assetName: `${width}x${height}-${String(i + 1).padStart(2, "0")}.${ext}`,
        });
      }

      const htmlItems = downloaded.map(x => ({
        src: `assets/${x.assetName}`,
        width: x.width,
        height: x.height,
      }));
      const html = responsiveHtml(htmlItems);

      const publicPath = encodePath(relativeBase);
      const creativeUrl = `${PUBLIC_BASE}/${publicPath}/creative.html`;
      const txt = ynetTxt(creativeUrl, input.landing_url);

      const ref = await gh(env, `/git/ref/heads/${BRANCH}`);
      const headSha = ref.object.sha as string;
      const commit = await gh(env, `/git/commits/${headSha}`);
      const baseTree = commit.tree.sha as string;

      const tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];

      for (const x of downloaded) {
        const sha = await createBlob(env, toBase64(x.bytes), "base64");
        tree.push({ path: `${repoBase}/assets/${x.assetName}`, mode: "100644", type: "blob", sha });
      }

      const htmlSha = await createBlob(env, html, "utf-8");
      const txtSha = await createBlob(env, txt, "utf-8");
      const metaSha = await createBlob(env, JSON.stringify({
        client: input.client,
        campaign: input.campaign,
        publisher,
        creative_name: input.creative_name,
        landing_url: input.landing_url,
        creative_url: creativeUrl,
        assets: downloaded.map(x => ({
          original: x.filename,
          hosted: x.assetName,
          width: x.width,
          height: x.height,
          mime: x.mime,
        })),
        created_at: new Date().toISOString(),
      }, null, 2), "utf-8");

      tree.push(
        { path: `${repoBase}/creative.html`, mode: "100644", type: "blob", sha: htmlSha },
        { path: `${repoBase}/YNET.txt`, mode: "100644", type: "blob", sha: txtSha },
        { path: `${repoBase}/metadata.json`, mode: "100644", type: "blob", sha: metaSha },
      );

      const newTree = await gh(env, "/git/trees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_tree: baseTree, tree }),
      });

      const newCommit = await gh(env, "/git/commits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Publish ${input.client} / ${input.campaign} / ${publisher} / ${input.creative_name}`,
          tree: newTree.sha,
          parents: [headSha],
        }),
      });

      await gh(env, `/git/refs/heads/${BRANCH}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
      });

      return jsonText({
        ok: true,
        status: "committed",
        commit_sha: newCommit.sha,
        creative_url: creativeUrl,
        ynet_txt: txt,
        repository_path: repoBase,
        note: "Cloudflare Git integration will deploy this commit automatically. The URL may take a short time to become live.",
      });
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(JSON.stringify({
        ok: true,
        service: "publisher-creatives-uploader",
        mcp: "/mcp",
        version: "0.2.0",
        githubConfigured: Boolean(env.GITHUB_TOKEN),
      }), { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    const handler = createMcpHandler(() => createServer(env), {
      route: "/mcp",
      responseMode: "auto",
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
