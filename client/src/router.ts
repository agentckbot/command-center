import { createRouter, createWebHistory } from 'vue-router'
import DashboardView from './views/DashboardView.vue'
import ProjectDetailView from './views/ProjectDetailView.vue'
import IdeaDetailView from './views/IdeaDetailView.vue'
import ProjectsView from './views/ProjectsView.vue'
import IdeasView from './views/IdeasView.vue'
import TasksView from './views/TasksView.vue'
import StatusView from './views/StatusView.vue'
import CronView from './views/CronView.vue'
import AgentsView from './views/AgentsView.vue'
import CostsView from './views/CostsView.vue'
import TradesView from './views/TradesView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: DashboardView },
    { path: '/projects', component: ProjectsView },
    { path: '/project/:id', component: ProjectDetailView, props: true },
    { path: '/trades', component: TradesView },
    { path: '/ideas', component: IdeasView },
    { path: '/idea/:id', component: IdeaDetailView },
    { path: '/tasks', component: TasksView },
    { path: '/status', component: StatusView },
    { path: '/cron', component: CronView },
    { path: '/agents', component: AgentsView },
    { path: '/costs', component: CostsView },
  ],
})

export default router
