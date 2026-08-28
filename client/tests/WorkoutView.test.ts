import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkoutView from '../src/views/WorkoutView.vue'

describe('WorkoutView', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the workout builder with default steps', () => {
    const wrapper = mount(WorkoutView)

    expect(wrapper.text()).toContain('Workout')
    expect(wrapper.text()).toContain('Quick Circuit')
    expect(wrapper.text()).toContain('Add exercise')
    expect(wrapper.text()).toContain('Jumping Jacks')
    expect(wrapper.text()).toContain('Recovery')
    expect(wrapper.text()).toContain('Test sound')
    expect(wrapper.text()).toContain('Saved Sets')
  })

  it('saves the current set into browser storage', async () => {
    const wrapper = mount(WorkoutView)
    const saveButton = wrapper.findAll('button').find((button) => button.text() === 'Save set')

    expect(saveButton).toBeTruthy()
    await saveButton!.trigger('click')

    const stored = JSON.parse(window.localStorage.getItem('command-center-workout-v1') || '{}')
    expect(Array.isArray(stored.savedRoutines)).toBe(true)
    expect(stored.savedRoutines).toHaveLength(1)
    expect(stored.savedRoutines[0].routineName).toBe('Quick Circuit')
    expect(wrapper.text()).toContain('Saved "Quick Circuit"')
  })

  it('exports the current set to a portable file', async () => {
    const createObjectURL = vi.fn(() => 'blob:workout-export')
    const revokeObjectURL = vi.fn()
    const originalCreateElement = document.createElement.bind(document)
    const exportLink = originalCreateElement('a')
    exportLink.click = vi.fn()

    window.URL.createObjectURL = createObjectURL
    window.URL.revokeObjectURL = revokeObjectURL
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'a') {
        return exportLink
      }
      return originalCreateElement(tagName)
    })

    const wrapper = mount(WorkoutView)
    const exportButton = wrapper.findAll('button').find((button) => button.text() === 'Export')

    expect(exportButton).toBeTruthy()
    await exportButton!.trigger('click')

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(exportLink.click).toHaveBeenCalledTimes(1)
    expect(exportLink.download).toBe('quick-circuit.workout.json')

    const exportedBlob = createObjectURL.mock.calls[0]?.[0] as Blob
    const exported = JSON.parse(await exportedBlob.text())
    expect(exported.version).toBe(1)
    expect(exported.routine.routineName).toBe('Quick Circuit')
    expect(exported.routine.steps).toHaveLength(5)
    expect(wrapper.text()).toContain('Exported "Quick Circuit"')
  })

  it('imports a workout set from a portable file', async () => {
    const wrapper = mount(WorkoutView)
    const fileInput = wrapper.find('input[type="file"]')
    const importedFile = new File(
      [
        JSON.stringify({
          version: 1,
          routine: {
            routineName: 'Hotel Circuit',
            steps: [
              { type: 'exercise', name: 'Burpees', durationSec: 30 },
              { type: 'pause', name: 'Breath', durationSec: 15 },
              { type: 'exercise', name: 'Lunges', durationSec: 40 },
            ],
          },
        }),
      ],
      'hotel-circuit.workout.json',
      { type: 'application/json' }
    )

    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [importedFile],
    })

    await fileInput.trigger('change')
    await Promise.resolve()

    expect((wrapper.find('input.set-name').element as HTMLInputElement).value).toBe('Hotel Circuit')
    expect(wrapper.find('.clock-name').text()).toContain('Burpees')
    expect(wrapper.text()).toContain('Imported "Hotel Circuit"')

    const stored = JSON.parse(window.localStorage.getItem('command-center-workout-v1') || '{}')
    expect(stored.draft.routineName).toBe('Hotel Circuit')
    expect(stored.draft.steps).toHaveLength(3)
  })

  it('keeps the moved step active when reordering the current exercise', async () => {
    const wrapper = mount(WorkoutView)
    const stepCards = () => wrapper.findAll('.step-card')
    const stepName = (index: number) => stepCards()[index]?.find('input.step-name').element.value
    const runnerCount = () => wrapper.find('.runner-panel .panel-count').text()

    expect(stepName(0)).toBe('Jumping Jacks')
    expect(wrapper.find('.clock-name').text()).toContain('Jumping Jacks')
    expect(runnerCount()).toContain('step 1 of 5')

    const firstDownButton = stepCards()[0]?.findAll('button').find((button) => button.text() === 'Down')
    expect(firstDownButton).toBeTruthy()
    await firstDownButton!.trigger('click')

    expect(stepName(1)).toBe('Jumping Jacks')
    expect(stepCards()[1]?.classes()).toContain('active')
    expect(wrapper.find('.clock-name').text()).toContain('Jumping Jacks')
    expect(runnerCount()).toContain('step 2 of 5')
  })

  it('lets you select another step without locking the builder', async () => {
    const wrapper = mount(WorkoutView)
    const stepCards = () => wrapper.findAll('.step-card')
    const runnerCount = () => wrapper.find('.runner-panel .panel-count').text()
    const addExerciseButton = wrapper.findAll('button').find((button) => button.text() === 'Add exercise')

    await stepCards()[2]!.trigger('click')

    expect(stepCards()[2]?.classes()).toContain('active')
    expect(wrapper.find('.clock-name').text()).toContain('Push-Ups')
    expect(runnerCount()).toContain('step 3 of 5')
    expect(wrapper.find('input.set-name').attributes('disabled')).toBeUndefined()
    expect(addExerciseButton?.attributes('disabled')).toBeUndefined()
  })
})
