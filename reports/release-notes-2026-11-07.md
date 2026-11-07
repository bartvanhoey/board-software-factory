## What's new

06 Nov – 07 Nov 2026

### Improvements
- The board now only shows links that lead to github.com. A card whose issue link points anywhere else is left off, and a pull request with an odd link is shown without that link.

### Under the hood
- Publishing a release now checks that the tests pass first, and it uses the Docker Hub login only from a protected release setup that works for version tags. The build steps are locked to exact versions, and a weekly update check keeps them current.
