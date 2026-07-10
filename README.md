# Blog

A Jekyll blog for tech and running posts, hosted free on GitHub Pages.

## Writing a new post

Add a Markdown file to `_posts/` named `YYYY-MM-DD-title-of-post.md`:

```markdown
---
title: "Your Post Title"
categories: [tech]   # or [running]
tags: [optional, tags]
---

Your content here, in Markdown.
```

Commit and push to `main` — GitHub Pages rebuilds the site automatically. No build step, no CI required.

## Previewing locally

Requires Ruby + Bundler (or use Docker, see below).

```bash
bundle install
bundle exec jekyll serve
```

Then open http://localhost:4000.

### Or with Docker (no Ruby install needed)

```bash
docker run --rm -it -v "${PWD}:/srv/jekyll" -p 4000:4000 jekyll/jekyll jekyll serve
```

## Publishing on GitHub Pages

1. Create a new GitHub repo (e.g. `blog`, or `<username>.github.io` if you want it at the root domain) and push this project to it.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch", branch `main`, folder `/ (root)`.
4. Save. The site will be live at `https://<username>.github.io/<repo>/` (or `https://<username>.github.io/` for a `.github.io` repo) within a minute or two.
5. If your repo is **not** named `<username>.github.io`, set `baseurl: "/<repo-name>"` in `_config.yml` so internal links resolve correctly.

## Customizing

- `_config.yml` — site title, description, author, email.
- `about.md` — the About page.
- `assets/css/style.css` — all styling, includes a dark-mode variant via `prefers-color-scheme`.
- `_layouts/` and `_includes/` — page templates and header/footer.
