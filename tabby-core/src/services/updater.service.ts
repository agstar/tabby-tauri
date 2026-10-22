export abstract class UpdaterService {
    isAvailable = true
    abstract check (): Promise<boolean>
    abstract update (): Promise<void>
}
