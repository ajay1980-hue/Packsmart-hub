const BANNER_URL = 'https://cdn.shopify.com/s/files/1/1059/3917/3710/files/packsmart-email-banner_d13858d4-9977-4b8b-bfa2-9910fe4b538d.png?v=1790697878';

export const PACKSMART_EMAIL_BRAND = Object.freeze({
  company: 'Packsmart Solutions Ltd',
  website: 'https://packsmartsolutions.com/',
  bannerUrl: BANNER_URL,
  socials: Object.freeze({
    linkedin: 'https://www.linkedin.com/company/packsmart-solutions-ltd/',
    instagram: 'https://www.instagram.com/packsmartsolutions/',
    facebook: 'https://www.facebook.com/profile.php?id=61592667608867',
    tiktok: 'https://www.tiktok.com/@packsmartsolutions'
  })
});

const FOOTER_MARKER = '<!-- packsmart-email-footer:v1 -->';

export function packsmartFooterHtml(){
  const { website, bannerUrl, socials } = PACKSMART_EMAIL_BRAND;
  return `${FOOTER_MARKER}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;margin-top:18px;">
  <tr><td>
    <a href="${website}" target="_blank" style="text-decoration:none;">
      <img src="${bannerUrl}" width="600" alt="Packsmart Solutions Ltd" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;">
    </a>
  </td></tr>
  <tr><td style="padding-top:10px;font-family:Arial,sans-serif;font-size:14px;line-height:20px;">
    <a href="${socials.linkedin}" target="_blank">LinkedIn</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
    <a href="${socials.instagram}" target="_blank">Instagram</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
    <a href="${socials.facebook}" target="_blank">Facebook</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;
    <a href="${socials.tiktok}" target="_blank">TikTok</a>
  </td></tr>
</table>`;
}

export function packsmartFooterText(){
  return [
    'Packsmart Solutions Ltd',
    'https://packsmartsolutions.com/',
    'LinkedIn: https://www.linkedin.com/company/packsmart-solutions-ltd/',
    'Instagram: https://www.instagram.com/packsmartsolutions/',
    'Facebook: https://www.facebook.com/profile.php?id=61592667608867',
    'TikTok: https://www.tiktok.com/@packsmartsolutions'
  ].join('\n');
}

export function hasPacksmartFooter(html=''){
  const value = String(html || '');
  return value.includes(FOOTER_MARKER) && value.includes(PACKSMART_EMAIL_BRAND.bannerUrl);
}

export function renderPacksmartEmail({ html = '', text = '' } = {}){
  const htmlValue = String(html || '').trim();
  const textValue = String(text || '').trim();
  return {
    html: hasPacksmartFooter(htmlValue) ? htmlValue : `${htmlValue}${htmlValue ? '\n' : ''}${packsmartFooterHtml()}`,
    text: `${textValue}${textValue ? '\n\n' : ''}${packsmartFooterText()}`
  };
}
