# Content Inbox Drop-Box (`content_inbox/`)

Drop raw job-site photos and homeowner testimonials into these folders for **Agent 1 (`MediaIngestorAgent`)**:

1. **`content_inbox/photos/`**:
   - Drop any `.jpg`, `.jpeg`, `.png`, or `.webp` roof photo.
   - Include the town name in the filename (e.g., `toms-river_silverton_roof.jpg` or `brick_midstreams.jpg`), OR place an optional `.json` sidecar file with the same name containing `town`, `neighborhood`, `service_type`, `shingle_system`, and `caption`.
   - When `MediaIngestorAgent` runs, it automatically:
     1. Stamps exact Ocean County GPS EXIF Latitude/Longitude coordinates into a `.jpg` for Google Business Profile.
     2. Converts and compresses a `.webp` version for fast website Core Web Vitals.
     3. Writes a localized SEO case-study summary and publishes the project card immediately onto the matching `/roofing-{town}-nj` landing page (`uploaded_by = 'owner'`).
     4. Moves the original file into `content_inbox/processed/`.

2. **`content_inbox/testimonials/`**:
   - Drop any `.json` or `.txt` customer testimonial.
   - Automatically imported into the `reviews` table and queued for an AI-drafted SEO owner reply.
