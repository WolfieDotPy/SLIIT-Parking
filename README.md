# SLIIT Parking System
Needs Node.js 22.13+ (LTS). Run: `npm install` then `npm start`.
- Students:  http://localhost:3000/student/   (register themselves)
- Admin:     http://localhost:3000/admin/     (password: admin123 - change it in Settings)
- Enforcers: http://localhost:3000/enforcer/  (admin registers them; they get an ID like EN001)
Each portal has its own login and only accepts its own account type.
Put your real logo at public/logo.png to replace the placeholder crest.
Set ADMIN_PASSWORD (first run only) and JWT_SECRET environment variables for production.
Data: sliit-parking.db and uploads/ (payment slips). Use HTTPS when deployed so phone cameras can scan QR codes.

## Editing the system yourself
Open the folder in VS Code (free). Stop the server (Ctrl+C), edit, then `npm start` again.
- `server.js` - all backend logic: login, fee calculation (search `finish`), approval rules, API routes.
- `public/style.css` - colours, fonts, glass look (top of file: `--ink`, `--line`).
- `public/student/index.html`, `public/admin/index.html`, `public/enforcer/index.html` - each portal's screens and scripts.
- `public/common.js` - helpers shared by all portals. `public/logo.png` - your logo (optional).

## Database access
- In the Admin portal: Database button -> view, edit, delete, grant passes, reset passwords, export CSV, download a full backup.
- Directly: the data is one file, `sliit-parking.db`, in the project folder. Install the free "DB Browser for SQLite" (sqlitebrowser.org),
  stop the server, open the file, edit tables in Browse Data, then press Write Changes. Tables: users, vehicles, passes, payments, fees, settings.
- Backup = copy `sliit-parking.db` and the `uploads` folder. Restore = put them back while the server is stopped.

## Editing data in Excel
Admin -> Database -> open a tab -> "Download this table (CSV)". Edit cells in Excel (keep the header row and the `id` column; only the
editable columns are read), save as CSV, then on the same tab press "Import edited CSV". It updates existing rows by id, all-or-nothing.
It cannot add or delete rows (use registration/Delete for that). Format phone numbers as Text in Excel so the leading 0 is kept,
and keep dates as YYYY-MM-DD. Download a full backup before importing.

## Adding many students from Excel
Admin -> Database -> Students -> "Download template". Columns: code (IT number), name, contact, vehicle, vehicle_type, password (min 6), pass_end
(optional YYYY-MM-DD: gives the student an active annual pass until that date). Leave `id` empty / absent, delete the example row,
save as CSV and press "Import edited CSV". Existing students already have a code, so duplicates are rejected. All-or-nothing.

Import accepts .xlsx or .csv. On the Students tab your own column names also work (Student ID, Full Name, Contact Number, Vehicle Number,
Vehicle Type, Pass Validity ...), extra columns are ignored, and an id that does not exist simply adds a new student.
If the password column is empty, the student's IT number becomes their starting password - reset it in Edit -> New password.

## Bulk import on every tab
Students, Enforcers, Vehicles, Passes and Fees each have a "Download template" button on their Database tab. Fill it in, save as .xlsx/.csv and press
Import. Rows whose id exists in the table update that row; other rows are added. Payments can only be updated (students create them by uploading slips).
Enforcers need a password (min 6). Vehicles and Passes use the student's IT number in the `student` column. If a password column is filled for an
existing student/enforcer row, that password is reset.
