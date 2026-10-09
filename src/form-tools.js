import {z} from 'zod';
import {result,formState,validateForm,upload,download,selectField,checkField,submit} from './forms.js';
export const target={selector:z.string().optional(),label:z.string().optional(),name:z.string().optional(),text:z.string().optional()};
export function registerFormTools(register,{browser,sessions,downloadDir,uploadRoots}) {
  register('browser_form_state','Read visible form fields, required files, options and validation errors; secrets are redacted.',{selector:z.string().optional()},async a=>result(await formState(await browser(),a)));
  register('browser_validate_form','List exact missing or invalid fields without submitting.',{selector:z.string().optional()},async a=>result(await validateForm(await browser(),a)));
  register('browser_upload','Attach verified files. paths are on the BROWSER SERVER, including /mnt/data if mounted there. For ChatGPT-container files use attachments built by the local prepare-upload helper; a path alone cannot cross machines.',{...target,paths:z.array(z.string()).min(1).max(10).optional(),attachments:z.array(z.object({name:z.string(),mimeType:z.string(),size:z.number().int().positive(),base64:z.string()})).min(1).max(10).optional()},async a=>result(await upload(await browser(),a,uploadRoots)));
  register('browser_download','Click a download link/button and return its exact browser-server path. returnBase64 also returns bytes up to 5 MiB for materializing in ChatGPT.',{...target,returnBase64:z.boolean().optional()},async a=>result(await download(await browser(),a,downloadDir)));
  register('browser_select','Select a native or accessible option by visible optionText or value.',{...target,optionText:z.string().optional(),value:z.string().optional()},async a=>result(await selectField(await browser(),a)));
  register('browser_check','Check a checkbox or select a radio. Ambiguous targets are refused.',target,async a=>result(await checkField(await browser(),a,true)));
  register('browser_uncheck','Uncheck a checkbox. Radios must be changed by selecting another option.',target,async a=>result(await checkField(await browser(),a,false)));
  register('browser_submit','Validate immediately before submit. Set knownValuesConfirmed only if every required value is factual and known. Never retry an unconfirmed outcome blindly.',{...target,formSelector:z.string().optional(),knownValuesConfirmed:z.boolean(),timeoutMs:z.number().int().min(500).max(15000).optional()},async a=>result(await submit(await browser(),a)));
  register('browser_session_use','Use a persistent isolated domain/account profile. Does not copy cookies from other profiles.',{domain:z.string(),account:z.string().default('default')},async a=>result(await sessions.use(a.domain,a.account)));
  register('browser_session_reset','Delete cookies/localStorage/tabs for this exact profile only. Other profiles remain intact.',{profile:z.string()},async a=>result(await sessions.reset(a.profile)));
}
