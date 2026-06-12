/**
 * Blog post page (gtm-marketing-launch-001).
 *
 * Renders one published post. content_html is produced by the Nexus
 * marketing engine (markdown → sanitized HTML at publish time) and stored
 * in the company's own DB — same trust model as the legal surface's
 * content_html (rendered with dangerouslySetInnerHTML).
 */
import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPostBySlug } from "@/lib/blog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default async function BlogPostPage({
  params,
}: {
  params: { slug: string };
}): Promise<JSX.Element> {
  const post = await getPostBySlug(params.slug);
  if (!post) notFound();
  return (
    <main>
      <p>
        <Link href="/blog">← All posts</Link>
      </p>
      <article>
        <h1>{post.title}</h1>
        <p>
          <small>
            {formatDate(post.published_at)} · {post.author}
          </small>
        </p>
        <div dangerouslySetInnerHTML={{ __html: post.content_html }} />
      </article>
    </main>
  );
}
