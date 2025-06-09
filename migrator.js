const http = require("http");
const https = require("https");
const { pipeline } = require("stream");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const streamPipeline = promisify(pipeline);
const WP_API = "https://www.cbdsvet.cz/wp-json/wp/v2/posts?_embed"; // Update this

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(JSON.parse(data)));
      })
      .on("error", reject);
  });
}

async function downloadImage(url, filePath) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(filePath);
    lib
      .get(url, (res) => {
        if (res.statusCode !== 200) return reject("Failed to download image");
        streamPipeline(res, file)
          .then(() => resolve(filePath))
          .catch(reject);
      })
      .on("error", reject);
  });
}

async function uploadToStrapi(filePath) {
  const fileStat = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const uploadedFiles = await strapi.plugin("upload").service("upload").upload({
    files: {
      path: filePath,
      name: fileName,
      type: "image/jpeg",
      size: fileStat.size,
      buffer,
    },
  });

  fs.unlinkSync(filePath);
  return uploadedFiles[0];
}

async function findCategoryIds(names = []) {
  const results = await Promise.all(
    names.map((name) =>
      strapi.entityService.findMany("api::category.category", {
        filters: { name: name },
        limit: 1,
      })
    )
  );
  return results.map((r) => (r[0] ? r[0].id : null)).filter(Boolean);
}

async function findTagIds(names = []) {
  const results = await Promise.all(
    names.map((name) =>
      strapi.entityService.findMany("api::tag.tag", {
        filters: { name: name },
        limit: 1,
      })
    )
  );
  return results.map((r) => (r[0] ? r[0].id : null)).filter(Boolean);
}

async function migrate() {
  let page = 1;
  while (true) {
    const posts = await fetchJson(`${WP_API}&per_page=100&page=${page}`);
    if (!posts.length) break;

    for (const post of posts) {
      const media = post._embedded?.["wp:featuredmedia"]?.[0];
      let coverImageId = null;

      if (media?.source_url) {
        try {
          const tmpFile = path.join(__dirname, `tmp_${Date.now()}.jpg`);
          await downloadImage(media.source_url, tmpFile);
          const uploaded = await uploadToStrapi(tmpFile);
          coverImageId = uploaded.id;
        } catch (err) {
          console.warn("⚠ Failed to handle media for post:", post.title.rendered);
        }
      }

      // Map categories and tags by name
      const wpCategories = post._embedded?.["wp:term"]?.flat()?.filter(t => t.taxonomy === "category") || [];
      const wpTags = post._embedded?.["wp:term"]?.flat()?.filter(t => t.taxonomy === "post_tag") || [];

      const categoryNames = wpCategories.map(cat => cat.name);
      const tagNames = wpTags.map(tag => tag.name);

      const categories = await findCategoryIds(categoryNames);
      const tags = await findTagIds(tagNames);

      try {
        await strapi.entityService.create("api::post.post", {
          data: {
            Title: post.title.rendered,
            Slug: post.slug,
            Content: post.content.rendered,
            IsPublished: post.status === "publish",
            publishedAt: post.date,
            CoverImage: coverImageId,
            Seo: {
              metaTitle: post.title.rendered,
              metaDescription: post.excerpt?.rendered || "",
              metaImage: coverImageId,
              keywords: tagNames.join(", "),
              structuredData: {},
            },
            categories,
            tags,
          },
        });

        console.log(`✔ Imported: ${post.title.rendered}`);
      } catch (err) {
        console.error(`❌ Failed: ${post.title.rendered}`, err.message);
      }
    }

    page++;
  }

  console.log("✅ Migration complete.");
}

(async () => {
  const strapiApp = await require("../src/index").createStrapi();
  await strapiApp.start();
  await migrate();
  await strapiApp.destroy();
})();

