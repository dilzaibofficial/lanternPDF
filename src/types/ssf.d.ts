/** The small subset of the "ssf" (spreadsheet number format) library that LanternPDF uses. */
declare module "ssf" {
  interface FormatOptions {
    date1904?: boolean;
  }
  const SSF: {
    format(format: string | number, value: number | string | boolean | Date, options?: FormatOptions): string;
  };
  export default SSF;
}
