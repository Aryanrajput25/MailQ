#!/usr/bin/env node
// Creates a free Ethereal test SMTP account and prints the variables to paste into Railway.
// Usage: cd backend && node scripts/create-ethereal.js
const nodemailer = require('nodemailer')
nodemailer.createTestAccount().then((a) => {
  console.log(`ETHEREAL_HOST=${a.smtp.host}\nETHEREAL_PORT=${a.smtp.port}\nETHEREAL_USER=${a.user}\nETHEREAL_PASS=${a.pass}`)
  console.log('\nView sent mail at https://ethereal.email/login with the user/pass above.')
}).catch((e) => { console.error('Failed:', e.message); process.exit(1) })
