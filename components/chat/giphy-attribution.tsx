export function GiphyAttribution() {
  return <span className="inline-block align-middle">
    <img src="/giphy/powered-by-light.png" alt="Powered By GIPHY" width={150} height={20} className="h-auto w-[150px] dark:hidden" />
    <img src="/giphy/powered-by-dark.png" alt="Powered By GIPHY" width={150} height={20} className="hidden h-auto w-[150px] dark:block" />
  </span>
}
